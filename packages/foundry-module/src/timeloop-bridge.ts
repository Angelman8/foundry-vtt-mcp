/**
 * Thin bridge to the Timeloop module's scripting API (game.modules.get("timeloop").api)
 * plus a generic scene update. No Timeloop logic lives here: the GM check is done by
 * the caller, then a fixed set of API methods is called.
 */

export interface TimeloopEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** Positional argument count of each API method, before the trailing `options`. */
export const TIMELOOP_METHODS: Readonly<Record<string, number>> = Object.freeze({
  getClock: 0,
  listPaths: 0,
  exportTimeline: 0,
  nextChange: 0,
  previousChange: 0,
  resetLoop: 0,
  getPath: 1,
  stateAt: 1,
  createPath: 1,
  deletePath: 1,
  removeCue: 1,
  tick: 1,
  jump: 1,
  resumeCanon: 1,
  importTimeline: 1,
  addChange: 2,
  removeChange: 2,
  renamePath: 2,
  addCue: 2,
  despawn: 2,
  updateChange: 3,
  retimeChange: 3,
  spawn: 3,
});

/** Methods whose null result means "not the active GM client": answer with the clock instead. */
const CLOCK_METHODS = new Set([
  'tick',
  'jump',
  'nextChange',
  'previousChange',
  'resetLoop',
  'resumeCanon',
]);

const jsonSafe = (value: unknown): any => JSON.parse(JSON.stringify(value ?? null));

const failure = (code: string, message: string, details?: unknown): TimeloopEnvelope => ({
  ok: false,
  error: details === undefined ? { code, message } : { code, message, details },
});

export async function callTimeloop(payload: {
  method: string;
  args?: unknown[];
  scene?: string | null;
}): Promise<TimeloopEnvelope> {
  const mod: any = (game as any).modules?.get('timeloop');
  if (!mod?.active) {
    return failure('no-timeloop', 'The Timeloop module is not active in this world.');
  }
  const api: any = mod.api;
  if (!api || api.version !== 1) {
    return failure(
      'no-timeloop',
      `The Timeloop API is not available at version 1 (found ${api ? String(api.version) : 'none'}).`
    );
  }

  const method = payload?.method;
  if (typeof method !== 'string' || !Object.hasOwn(TIMELOOP_METHODS, method)) {
    return failure('invalid', `Unknown Timeloop method: ${String(method)}`);
  }
  const arity = TIMELOOP_METHODS[method] as number;

  const args = payload.args ?? [];
  if (!Array.isArray(args)) {
    return failure('invalid', 'args must be an array.');
  }
  if (args.length > arity) {
    return failure('invalid', `${method} takes at most ${arity} argument(s); got ${args.length}.`);
  }
  const padded = [...args];
  while (padded.length < arity) padded.push(undefined);

  const options =
    typeof payload.scene === 'string' && payload.scene ? { scene: payload.scene } : {};

  try {
    let value = await api[method](...padded, options);
    if (value == null && CLOCK_METHODS.has(method)) {
      value = await api.getClock(options);
    }
    return { ok: true, result: jsonSafe(value) };
  } catch (err: any) {
    if (typeof api.TimeloopApiError === 'function' && err instanceof api.TimeloopApiError) {
      return failure(err.code, err.message, jsonSafe(err.details));
    }
    return failure('error', err instanceof Error ? err.message : String(err));
  }
}

const REFUSED_KEYS = new Set([
  '_id',
  '_stats',
  'folder',
  'ownership',
  'tokens',
  'walls',
  'lights',
  'sounds',
  'tiles',
  'notes',
  'drawings',
  'templates',
  'regions',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every key path in `updates`, dotted, with nested objects walked: `{flags: {core: {x: 1}}}` gives `flags`,
 * `flags.core` and `flags.core.x`. Dotted keys are split, so `{"flags.core": …}` gives the same paths.
 */
function keyPaths(updates: Record<string, unknown>, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const [key, value] of Object.entries(updates)) {
    const path = [...prefix, ...key.split('.')];
    for (let i = prefix.length + 1; i <= path.length; i++) out.push(path.slice(0, i));
    if (isPlainObject(value)) out.push(...keyPaths(value, path));
  }
  return out;
}

/**
 * Why a key path is refused, or null. Foundry's `-=` (delete) and `==` (replace) key prefixes are refused anywhere:
 * `{"==walls": []}` would empty the scene's walls.
 */
function refusal(path: string[]): string | null {
  if (path.some(part => part.startsWith('-=') || part.startsWith('=='))) return path.join('.');
  if (REFUSED_KEYS.has(path[0] as string)) return path.join('.');
  if (path[0] === 'flags' && path[1] === 'core') return path.join('.');
  return null;
}

/** `{"a.b": 1}` → `{a: {b: 1}}`, recursively, on a copy. */
function expand(updates: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(updates)) {
    const value = isPlainObject(raw) ? expand(raw) : raw;
    const parts = key.split('.');
    let cur = out;
    for (const part of parts.slice(0, -1)) {
      if (!isPlainObject(cur[part])) cur[part] = {};
      cur = cur[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1] as string;
    cur[last] = isPlainObject(cur[last]) && isPlainObject(value) ? { ...(cur[last] as object), ...value } : value;
  }
  return out;
}

export async function updateScene(payload: {
  scene_identifier: string;
  updates: Record<string, unknown>;
}): Promise<object> {
  const identifier = payload?.scene_identifier;
  if (typeof identifier !== 'string' || !identifier) {
    throw new Error('scene_identifier is required');
  }
  const scenes: any[] = (game as any).scenes?.contents ?? [];
  let scene = scenes.find(s => s.id === identifier);
  if (!scene) {
    const matches = scenes.filter(s => s.name.toLowerCase() === identifier.toLowerCase());
    if (matches.length > 1) {
      throw new Error(
        `Scene name is ambiguous: "${identifier}" matches ${matches.length} scenes (${matches
          .map(s => s.id)
          .join(', ')}). Use the scene id.`
      );
    }
    scene = matches[0];
  }
  if (!scene) throw new Error(`Scene not found: "${identifier}"`);

  const updates = payload.updates;
  if (
    updates === null ||
    typeof updates !== 'object' ||
    Array.isArray(updates) ||
    Object.keys(updates).length === 0
  ) {
    throw new Error('updates must be a non-empty object of scene fields');
  }
  const refused = [...new Set(keyPaths(updates).map(refusal).filter((r): r is string => r !== null))];
  if (refused.length > 0) {
    throw new Error(
      `Refused update key(s): ${refused.join(', ')}. Embedded documents (tokens, walls, lights, ...) have their own tools; ids, stats, folder, ownership and flags.core cannot be changed here, and -= / == key operators are not allowed.`
    );
  }

  // The same dry run Foundry's client backend does before writing: it throws a readable error for invalid data
  // (which scene.update would only show as a notification) and gives the diff the update resolves to.
  const changes = expand(JSON.parse(JSON.stringify(updates)));
  const diff: Record<string, unknown> =
    scene.updateSource(changes, { dryRun: true, fallback: false }) ?? {};
  delete diff._id;
  if (Object.keys(diff).length === 0) {
    return { success: true, sceneId: scene.id, sceneName: scene.name, changed: {} };
  }
  const updated = await scene.update(expand(updates));
  if (updated === undefined) {
    throw new Error('The scene update was prevented (a module or hook refused it). Nothing was changed.');
  }
  return { success: true, sceneId: scene.id, sceneName: scene.name, changed: jsonSafe(diff) };
}
