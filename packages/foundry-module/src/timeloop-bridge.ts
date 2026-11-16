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
  'levels',
]);

/**
 * Foundry v14 moved a scene's background, foreground and fog image onto its Levels; `Scene#background` is a
 * read-only shim over the first Level, so writes to these keys are dropped. Pairs of [scene key, first-Level key],
 * as in v14's `BaseScene._LEVELS_PROPERTY_MAP` (used when present).
 */
const LEVEL_KEYS_FALLBACK: readonly (readonly [string, string])[] = [
  ['background.src', 'background.src'],
  ['background.tint', 'background.tint'],
  ['background.alphaThreshold', 'background.alphaThreshold'],
  ['background.anchorX', 'textures.anchorX'],
  ['background.anchorY', 'textures.anchorY'],
  ['background.fit', 'textures.fit'],
  ['background.scaleX', 'textures.scaleX'],
  ['background.scaleY', 'textures.scaleY'],
  ['background.rotation', 'textures.rotation'],
  ['fog.overlay', 'fog.src'],
  ['foreground', 'foreground.src'],
  ['foregroundElevation', 'elevation.top'],
  ['backgroundColor', 'background.color'],
];

/** The v14 shim also maps background offsets to the scene's own shift fields. */
const SCENE_RENAMES: readonly (readonly [string, string])[] = [
  ['background.offsetX', 'shiftX'],
  ['background.offsetY', 'shiftY'],
];

function levelKeyMap(): readonly (readonly [string, string])[] {
  const map = (globalThis as any).foundry?.documents?.BaseScene?._LEVELS_PROPERTY_MAP;
  return Array.isArray(map) && map.length > 0 ? map : LEVEL_KEYS_FALLBACK;
}

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

/** Remove the value at `parts` from `obj`, pruning parents left empty. */
function take(obj: Record<string, unknown>, parts: string[]): { found: boolean; value?: unknown } {
  const [head, ...rest] = parts as [string, ...string[]];
  if (!(head in obj)) return { found: false };
  if (rest.length === 0) {
    const value = obj[head];
    delete obj[head];
    return { found: true, value };
  }
  const child = obj[head];
  if (!isPlainObject(child)) return { found: false };
  const result = take(child, rest);
  if (result.found && Object.keys(child).length === 0) delete obj[head];
  return result;
}

function put(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

/**
 * Split expanded scene changes into the scene's own and its first Level's (v14). On a scene without Levels
 * (before v14) everything stays on the scene.
 */
function splitLevelChanges(
  scene: any,
  changes: Record<string, unknown>
): { level: any; levelChanges: Record<string, unknown> } {
  const levelChanges: Record<string, unknown> = {};
  const level = scene.levels?.size ? scene.firstLevel : null;
  if (!level) return { level: null, levelChanges };
  for (const [sceneKey, levelKey] of levelKeyMap()) {
    const t = take(changes, sceneKey.split('.'));
    if (t.found) put(levelChanges, levelKey.split('.'), t.value);
  }
  for (const [oldKey, newKey] of SCENE_RENAMES) {
    const t = take(changes, oldKey.split('.'));
    if (t.found) put(changes, newKey.split('.'), t.value);
  }
  return { level, levelChanges };
}

function dryRun(doc: any, changes: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(changes).length === 0) return {};
  const diff: Record<string, unknown> =
    doc.updateSource(JSON.parse(JSON.stringify(changes)), { dryRun: true, fallback: false }) ?? {};
  delete diff._id;
  return diff;
}

const PREVENTED = 'The scene update was prevented (a module or hook refused it).';

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

  const changes = expand(JSON.parse(JSON.stringify(updates)));
  const { level, levelChanges } = splitLevelChanges(scene, changes);

  // The same dry run Foundry's client backend does before writing: it throws a readable error for invalid data
  // (which update() would only show as a notification) and gives the diff the update resolves to. Both dry runs
  // happen before either write.
  const diff = dryRun(scene, changes);
  const levelDiff = level ? dryRun(level, levelChanges) : {};
  const result: Record<string, unknown> = { success: true, sceneId: scene.id, sceneName: scene.name };

  if (Object.keys(levelDiff).length > 0) {
    const updated = await level.update(JSON.parse(JSON.stringify(levelChanges)));
    if (updated === undefined) throw new Error(`${PREVENTED} Nothing was changed.`);
    result.level = { id: level.id, name: level.name, changed: jsonSafe(levelDiff) };
  }
  if (Object.keys(diff).length > 0) {
    const updated = await scene.update(JSON.parse(JSON.stringify(changes)));
    if (updated === undefined) {
      throw new Error(
        result.level ? `${PREVENTED} The Level changes were written, the scene's were not.` : `${PREVENTED} Nothing was changed.`
      );
    }
  }
  result.changed = jsonSafe(diff);
  return result;
}
