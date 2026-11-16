import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMELOOP_METHODS, callTimeloop, updateScene } from './timeloop-bridge.js';

class FakeApiError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, message: string, details: unknown = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function stubTimeloop(api: Record<string, unknown> | undefined, active = true) {
  vi.stubGlobal('game', {
    modules: {
      get: (id: string) => (id === 'timeloop' ? { active, api } : undefined),
    },
  });
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    TimeloopApiError: FakeApiError,
    getClock: vi.fn().mockResolvedValue({ time: 5 }),
    spawn: vi.fn().mockResolvedValue({ ok: 1 }),
    listPaths: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TIMELOOP_METHODS', () => {
  it('is frozen and has the expected arities', () => {
    expect(Object.isFrozen(TIMELOOP_METHODS)).toBe(true);
    expect(TIMELOOP_METHODS.getClock).toBe(0);
    expect(TIMELOOP_METHODS.getPath).toBe(1);
    expect(TIMELOOP_METHODS.addChange).toBe(2);
    expect(TIMELOOP_METHODS.spawn).toBe(3);
    expect(Object.keys(TIMELOOP_METHODS)).toHaveLength(23);
  });
});

describe('callTimeloop', () => {
  it('reports no-timeloop when the module is missing', async () => {
    vi.stubGlobal('game', { modules: { get: () => undefined } });
    const r = await callTimeloop({ method: 'getClock' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('no-timeloop');
    expect(r.error?.message).toBe('The Timeloop module is not active in this world.');
  });

  it('reports no-timeloop when the module is inactive', async () => {
    stubTimeloop(makeApi(), false);
    expect((await callTimeloop({ method: 'getClock' })).error?.code).toBe('no-timeloop');
  });

  it('reports no-timeloop for a missing api or a different version', async () => {
    stubTimeloop(undefined);
    expect((await callTimeloop({ method: 'getClock' })).error?.code).toBe('no-timeloop');
    stubTimeloop(makeApi({ version: 2 }));
    const r = await callTimeloop({ method: 'getClock' });
    expect(r.error?.code).toBe('no-timeloop');
    expect(r.error?.message).toContain('2');
  });

  it('rejects an unknown method, including inherited names', async () => {
    stubTimeloop(makeApi());
    const r = await callTimeloop({ method: 'nuke' });
    expect(r.error?.code).toBe('invalid');
    expect(r.error?.message).toContain('Unknown Timeloop method: nuke');
    expect((await callTimeloop({ method: 'toString' })).error?.code).toBe('invalid');
  });

  it('rejects too many arguments and non-array args', async () => {
    const api = makeApi();
    stubTimeloop(api);
    expect((await callTimeloop({ method: 'getClock', args: [1] })).error?.code).toBe('invalid');
    expect((await callTimeloop({ method: 'getPath', args: ['a'] as any })).ok).toBe(false);
    expect((await callTimeloop({ method: 'listPaths', args: 'x' as any })).error?.code).toBe(
      'invalid'
    );
  });

  it('pads missing arguments and passes the scene option', async () => {
    const api = makeApi();
    stubTimeloop(api);
    const r = await callTimeloop({ method: 'spawn', args: ['Thief', '09:30'], scene: 'X' });
    expect(r).toEqual({ ok: true, result: { ok: 1 } });
    expect(api.spawn).toHaveBeenCalledWith('Thief', '09:30', undefined, { scene: 'X' });
  });

  it('passes empty options when scene is absent, null or empty', async () => {
    const api = makeApi();
    stubTimeloop(api);
    await callTimeloop({ method: 'listPaths' });
    await callTimeloop({ method: 'listPaths', scene: null });
    await callTimeloop({ method: 'listPaths', scene: '' });
    for (const call of (api.listPaths as any).mock.calls) {
      expect(call).toEqual([{}]);
    }
  });

  it('makes results JSON-safe', async () => {
    const api = makeApi({
      listPaths: vi.fn().mockReturnValue({ a: undefined, b: new Date(0), c: () => 1, d: 1 }),
      getPath: vi.fn().mockReturnValue(undefined),
    });
    stubTimeloop(api);
    expect((await callTimeloop({ method: 'listPaths' })).result).toEqual({
      b: '1970-01-01T00:00:00.000Z',
      d: 1,
    });
    expect(await callTimeloop({ method: 'getPath', args: ['p'] })).toEqual({
      ok: true,
      result: null,
    });
  });

  it('falls back to getClock when a clock method returns null', async () => {
    const api = makeApi({
      tick: vi.fn().mockResolvedValue(null),
      getPath: vi.fn().mockResolvedValue(null),
    });
    stubTimeloop(api);
    const r = await callTimeloop({ method: 'tick', args: ['5m'], scene: 'S' });
    expect(r).toEqual({ ok: true, result: { time: 5 } });
    expect(api.getClock).toHaveBeenCalledWith({ scene: 'S' });
    // Non-clock methods keep their null.
    expect(await callTimeloop({ method: 'getPath', args: ['p'] })).toEqual({
      ok: true,
      result: null,
    });
  });

  it('maps a TimeloopApiError to an envelope with JSON-safe details', async () => {
    const api = makeApi({
      getPath: vi
        .fn()
        .mockRejectedValue(new FakeApiError('not-found', 'There is no such path.', { ref: 'x' })),
    });
    stubTimeloop(api);
    expect(await callTimeloop({ method: 'getPath', args: ['x'] })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'There is no such path.', details: { ref: 'x' } },
    });
  });

  it('maps any other error to code "error"', async () => {
    const api = makeApi({ getPath: vi.fn().mockRejectedValue(new Error('boom')) });
    stubTimeloop(api);
    expect(await callTimeloop({ method: 'getPath', args: ['x'] })).toEqual({
      ok: false,
      error: { code: 'error', message: 'boom' },
    });
  });
});

describe('updateScene', () => {
  function stubScenes(scenes: any[]) {
    vi.stubGlobal('game', { scenes: { contents: scenes } });
  }
  /** A shallow stand-in for DataModel#updateSource dry runs: top-level values that differ from `source`. */
  const dryRunDiff = (source: any) =>
    vi.fn((changes: any) => {
      const diff: any = {};
      for (const [k, v] of Object.entries(changes)) {
        if (JSON.stringify(v) !== JSON.stringify(source[k])) diff[k] = v;
      }
      return diff;
    });
  const makeScene = (id: string, name: string, source: any = {}, update?: any, updateSource?: any) => ({
    id,
    name,
    updateSource: updateSource ?? dryRunDiff(source),
    update: update ?? vi.fn().mockResolvedValue({}),
  });

  it('throws when the scene is not found', async () => {
    stubScenes([makeScene('a', 'Inn')]);
    await expect(updateScene({ scene_identifier: 'Nope', updates: { name: 'x' } })).rejects.toThrow(
      'Scene not found: "Nope"'
    );
  });

  it('throws on an ambiguous name but accepts an id', async () => {
    const one = makeScene('a', 'Inn');
    const two = makeScene('b', 'inn');
    stubScenes([one, two]);
    await expect(updateScene({ scene_identifier: 'INN', updates: { name: 'x' } })).rejects.toThrow(
      /ambiguous/
    );
    const r: any = await updateScene({ scene_identifier: 'b', updates: { name: 'x' } });
    expect(r.sceneId).toBe('b');
  });

  it.each([[{}], [null], [[1]], ['x'], [undefined]])('refuses updates %j', async updates => {
    stubScenes([makeScene('a', 'Inn')]);
    await expect(updateScene({ scene_identifier: 'a', updates: updates as any })).rejects.toThrow(
      'non-empty object'
    );
  });

  it.each([
    '_id',
    '_stats',
    'folder',
    'ownership',
    'ownership.default',
    'flags.core',
    'flags.core.sheetClass',
    'tokens',
    'walls',
    'lights',
    'sounds',
    'tiles',
    'notes',
    'drawings',
    'templates',
    'regions',
    'tokens.0.x',
    '==walls',
    '-=tokens',
    'flags.-=core',
    '-=flags',
    'background.==src',
  ])('refuses key %s without updating', async key => {
    const scene = makeScene('a', 'Inn');
    stubScenes([scene]);
    await expect(
      updateScene({ scene_identifier: 'a', updates: { name: 'ok', [key]: 1 } })
    ).rejects.toThrow(key);
    expect(scene.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ flags: { core: { sheetClass: 'x' } } }, 'flags.core'],
    [{ flags: { 'core.sheetClass': 'x' } }, 'flags.core'],
    [{ ownership: { default: 3 } }, 'ownership'],
    [{ background: { '==src': 'x' } }, 'background.==src'],
  ])('refuses nested key in %j', async (updates, key) => {
    const scene = makeScene('a', 'Inn');
    stubScenes([scene]);
    await expect(updateScene({ scene_identifier: 'a', updates: updates as any })).rejects.toThrow(key);
    expect(scene.update).not.toHaveBeenCalled();
  });

  it('allows other flags and scene fields', async () => {
    const scene = makeScene('a', 'Inn');
    stubScenes([scene]);
    await updateScene({ scene_identifier: 'a', updates: { 'flags.mymod.x': 1, navigation: true } });
    expect(scene.update).toHaveBeenCalledTimes(1);
  });

  it('dry-runs expanded changes, updates, and returns the dry-run diff without _id', async () => {
    const updateSource = vi.fn().mockReturnValue({ _id: 'a', background: { src: 'maps/inn.webp' }, name: 'The Inn' });
    const scene = makeScene('a', 'Inn', {}, undefined, updateSource);
    stubScenes([scene]);
    const updates = { 'background.src': 'maps/inn.webp', darkness: 0, name: 'The Inn' };
    const r = await updateScene({ scene_identifier: 'inn', updates });
    const expanded = { background: { src: 'maps/inn.webp' }, darkness: 0, name: 'The Inn' };
    expect(updateSource).toHaveBeenCalledWith(expanded, { dryRun: true, fallback: false });
    expect(scene.update).toHaveBeenCalledWith(expanded);
    expect(updates).toEqual({ 'background.src': 'maps/inn.webp', darkness: 0, name: 'The Inn' });
    expect(r).toEqual({
      success: true,
      sceneId: 'a',
      sceneName: 'Inn',
      changed: { background: { src: 'maps/inn.webp' }, name: 'The Inn' },
    });
  });

  it('does not update when nothing would change', async () => {
    const scene = makeScene('a', 'Inn', { darkness: 0 });
    stubScenes([scene]);
    const r: any = await updateScene({ scene_identifier: 'a', updates: { darkness: 0 } });
    expect(r.changed).toEqual({});
    expect(scene.update).not.toHaveBeenCalled();
  });

  it('throws the validation error and does not update', async () => {
    const updateSource = vi.fn(() => {
      throw new Error('grid.size: must be an integer');
    });
    const scene = makeScene('a', 'Inn', {}, undefined, updateSource);
    stubScenes([scene]);
    await expect(
      updateScene({ scene_identifier: 'a', updates: { 'grid.size': 'big' } })
    ).rejects.toThrow('must be an integer');
    expect(scene.update).not.toHaveBeenCalled();
  });

  it('throws when the update is prevented', async () => {
    const scene = makeScene('a', 'Inn', { darkness: 0 }, vi.fn().mockResolvedValue(undefined));
    stubScenes([scene]);
    await expect(
      updateScene({ scene_identifier: 'a', updates: { darkness: 1 } })
    ).rejects.toThrow(/prevented/);
  });
});
