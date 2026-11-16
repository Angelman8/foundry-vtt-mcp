import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeloopTools } from './timeloop.js';

const QUERY = 'foundry-mcp-bridge.timeloop';

function makeTools(reply: any = { ok: true, result: { done: true } }) {
  const query = vi.fn().mockResolvedValue(reply);
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new TimeloopTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('timeloop tools: payloads', () => {
  const cases: Array<[string, string, any, any]> = [
    ['handleGet', 'clock', { what: 'clock' }, { method: 'getClock', args: [], scene: null }],
    ['handleGet', 'paths', { what: 'paths', scene: 'Inn' }, { method: 'listPaths', args: [], scene: 'Inn' }],
    [
      'handleGet',
      'path',
      { what: 'path', path: { token: 'Thief' } },
      { method: 'getPath', args: [{ token: 'Thief' }], scene: null },
    ],
    ['handleGet', 'state', { what: 'state', time: '09:30' }, { method: 'stateAt', args: ['09:30'], scene: null }],
    [
      'handleCreatePath',
      'create',
      { token: 'Thief', scene: 'Inn' },
      { method: 'createPath', args: [{ token: 'Thief' }], scene: 'Inn' },
    ],
    [
      'handleCreatePath',
      'create darkness',
      { darkness: true },
      { method: 'createPath', args: [{ darkness: true }], scene: null },
    ],
    [
      'handleEditPath',
      'rename',
      { operation: 'rename', path: 'Thief', name: 'Burglar' },
      { method: 'renamePath', args: ['Thief', 'Burglar'], scene: null },
    ],
    [
      'handleEditPath',
      'delete',
      { operation: 'delete', path: 'Thief' },
      { method: 'deletePath', args: ['Thief'], scene: null },
    ],
    [
      'handleAddChange',
      'add change',
      { path: 'Thief', change: { time: '09:30', at: { x: 1, y: 2 } } },
      { method: 'addChange', args: ['Thief', { time: '09:30', at: { x: 1, y: 2 } }], scene: null },
    ],
    [
      'handleEditChange',
      'update',
      { operation: 'update', path: 'Thief', change: 0, patch: { duration: null } },
      { method: 'updateChange', args: ['Thief', 0, { duration: null }], scene: null },
    ],
    [
      'handleEditChange',
      'retime',
      { operation: 'retime', path: 'Thief', change: { time: 10 }, time: '09:45' },
      { method: 'retimeChange', args: ['Thief', { time: 10 }, '09:45'], scene: null },
    ],
    [
      'handleEditChange',
      'remove',
      { operation: 'remove', path: 'Thief', change: 2 },
      { method: 'removeChange', args: ['Thief', 2], scene: null },
    ],
    [
      'handleCue',
      'cue add',
      { operation: 'add', cue: { type: 'chat', text: 'Bell' }, time: '10:00' },
      { method: 'addCue', args: [{ type: 'chat', text: 'Bell' }, '10:00'], scene: null },
    ],
    [
      'handleCue',
      'cue remove',
      { operation: 'remove', id: 'abc' },
      { method: 'removeCue', args: ['abc'], scene: null },
    ],
    [
      'handlePresence',
      'spawn with at',
      { operation: 'spawn', token: 'Thief', time: '09:30', at: { x: 5, y: 6 } },
      { method: 'spawn', args: ['Thief', '09:30', { at: { x: 5, y: 6 } }], scene: null },
    ],
    [
      'handlePresence',
      'spawn without at',
      { operation: 'spawn', token: 'Thief', time: 30 },
      { method: 'spawn', args: ['Thief', 30, { at: undefined }], scene: null },
    ],
    [
      'handlePresence',
      'despawn',
      { operation: 'despawn', token: 'Thief', time: 30 },
      { method: 'despawn', args: ['Thief', 30], scene: null },
    ],
    ['handleClock', 'tick', { operation: 'tick', duration: '5m' }, { method: 'tick', args: ['5m'], scene: null }],
    ['handleClock', 'jump', { operation: 'jump', time: '08:00' }, { method: 'jump', args: ['08:00'], scene: null }],
    ['handleClock', 'next', { operation: 'next' }, { method: 'nextChange', args: [], scene: null }],
    ['handleClock', 'previous', { operation: 'previous' }, { method: 'previousChange', args: [], scene: null }],
    ['handleClock', 'reset', { operation: 'reset' }, { method: 'resetLoop', args: [], scene: null }],
    ['handleClock', 'resume all', { operation: 'resume' }, { method: 'resumeCanon', args: [null], scene: null }],
    [
      'handleClock',
      'resume keys',
      { operation: 'resume', keys: ['a', 'b'] },
      { method: 'resumeCanon', args: [['a', 'b']], scene: null },
    ],
    ['handleExport', 'export', {}, { method: 'exportTimeline', args: [], scene: null }],
    [
      'handleImport',
      'import data',
      { data: '{"x":1}', scene: 'Copy' },
      { method: 'importTimeline', args: ['{"x":1}'], scene: 'Copy' },
    ],
  ];

  it.each(cases)('%s (%s) builds the payload', async (handler, _label, input, expected) => {
    const { tools, query } = makeTools();
    const result = await (tools as any)[handler](input);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(QUERY, expected);
    expect(result).toEqual({ done: true });
  });

  it('defines every tool name', () => {
    const { tools } = makeTools();
    expect(tools.getToolDefinitions().map((t: any) => t.name)).toEqual([
      'timeloop-get',
      'timeloop-create-path',
      'timeloop-edit-path',
      'timeloop-add-change',
      'timeloop-edit-change',
      'timeloop-cue',
      'timeloop-presence',
      'timeloop-clock',
      'timeloop-export',
      'timeloop-import',
    ]);
  });
});

describe('timeloop tools: validation before any query', () => {
  const bad: Array<[string, any]> = [
    ['handleGet', { what: 'path' }],
    ['handleGet', { what: 'bogus' }],
    ['handleCreatePath', {}],
    ['handleCreatePath', { token: 'A', wall: 'b' }],
    ['handleEditPath', { operation: 'rename', path: 'Thief' }],
    ['handleAddChange', { path: 'Thief' }],
    ['handleEditChange', { operation: 'update', path: 'Thief', change: 0 }],
    ['handleEditChange', { operation: 'retime', path: 'Thief', change: 0 }],
    ['handleCue', { operation: 'add', time: 5 }],
    ['handleCue', { operation: 'add', cue: { type: 'chat' } }],
    ['handleCue', { operation: 'remove' }],
    ['handlePresence', { operation: 'spawn', token: 'Thief' }],
    ['handleClock', { operation: 'tick' }],
    ['handleClock', { operation: 'jump' }],
    ['handleImport', {}],
    ['handleImport', { data: '{}', file: '/x.json' }],
  ];

  it.each(bad)('%s refuses %j', async (handler, input) => {
    const { tools, query } = makeTools();
    await expect((tools as any)[handler](input)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('timeloop tools: errors', () => {
  it('turns an error envelope into an Error naming the code', async () => {
    const { tools } = makeTools({
      ok: false,
      error: { code: 'not-found', message: 'No such path', details: { path: 'X' } },
    });
    await expect(tools.handleGet({ what: 'paths' })).rejects.toThrow(
      'Timeloop not-found: No such path {"path":"X"}'
    );
  });

  it('omits details when there are none', async () => {
    const { tools } = makeTools({ ok: false, error: { code: 'no-timeloop', message: 'Inactive' } });
    await expect(tools.handleGet({ what: 'clock' })).rejects.toThrow(/^Timeloop no-timeloop: Inactive$/);
  });

  it('omits empty details', async () => {
    const { tools } = makeTools({ ok: false, error: { code: 'no-scene', message: 'No scene', details: {} } });
    await expect(tools.handleGet({ what: 'clock' })).rejects.toThrow(/^Timeloop no-scene: No scene$/);
  });

  it('passes extra placement fields through for spawn', async () => {
    const { tools, query } = makeTools();
    await tools.handlePresence({ operation: 'spawn', token: 'Thief', time: 10, at: { x: 1, y: 2, elevation: 5 } });
    expect(query).toHaveBeenCalledWith(QUERY, {
      method: 'spawn',
      args: ['Thief', 10, { at: { x: 1, y: 2, elevation: 5 } }],
      scene: null,
    });
  });

  it('accepts darkness: false alongside another target', async () => {
    const { tools, query } = makeTools();
    await tools.handleCreatePath({ token: 'Thief', darkness: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('turns Access denied into an error', async () => {
    const { tools } = makeTools({ error: 'Access denied', success: false });
    await expect(tools.handleGet({ what: 'clock' })).rejects.toThrow('Access denied');
  });
});

describe('timeloop-export / timeloop-import with files', () => {
  let dir: string;
  const exported = {
    format: 'timeloop.timeline',
    timeline: {
      tracks: [
        { kind: 'token', keys: [{ t: 1 }, { t: 2 }] },
        { kind: 'door', keys: [{ t: 3 }] },
        { kind: 'cue', keys: [{ t: 4 }, { t: 5 }, { t: 6 }] },
        { kind: 'light' },
      ],
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'timeloop-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file, returns the summary, and refuses a second write', async () => {
    const { tools, query } = makeTools({ ok: true, result: exported });
    const file = path.join(dir, 'out.json');

    const result = await tools.handleExport({ file });
    expect(result).toEqual({ file, summary: { paths: 3, changes: 3, cues: 3 } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(exported);
    expect(query).toHaveBeenCalledWith(QUERY, { method: 'exportTimeline', args: [], scene: null });

    await expect(tools.handleExport({ file })).rejects.toThrow(/already exists/);
    await expect(tools.handleExport({ file, overwrite: true })).resolves.toMatchObject({ file });
  });

  it('returns the export object without a file', async () => {
    const { tools } = makeTools({ ok: true, result: exported });
    expect(await tools.handleExport({})).toEqual(exported);
  });

  it('refuses a relative path or a non-json name before any query', async () => {
    const { tools, query } = makeTools({ ok: true, result: exported });
    await expect(tools.handleExport({ file: 'out.json' })).rejects.toThrow(/absolute/);
    await expect(tools.handleExport({ file: path.join(dir, 'out.txt') })).rejects.toThrow(/\.json/);
    expect(query).not.toHaveBeenCalled();
  });

  it('imports a file by sending its text', async () => {
    const { tools, query } = makeTools({ ok: true, result: { summary: {}, warnings: [], missing: {} } });
    const file = path.join(dir, 'in.json');
    await writeFile(file, '{"format":"timeloop.timeline"}', 'utf8');

    const result = await tools.handleImport({ file, scene: 'Copy' });
    expect(query).toHaveBeenCalledWith(QUERY, {
      method: 'importTimeline',
      args: ['{"format":"timeloop.timeline"}'],
      scene: 'Copy',
    });
    expect(result).toEqual({ summary: {}, warnings: [], missing: {} });
  });

  it('strips a UTF-8 byte order mark from an imported file', async () => {
    const { tools, query } = makeTools({ ok: true, result: {} });
    const file = path.join(dir, 'bom.json');
    await writeFile(file, '﻿{"format":"timeloop.timeline"}', 'utf8');
    await tools.handleImport({ file });
    expect(query.mock.calls[0][1].args).toEqual(['{"format":"timeloop.timeline"}']);
  });

  it('refuses a relative or non-json import path', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleImport({ file: 'in.json' })).rejects.toThrow(/absolute/);
    await expect(tools.handleImport({ file: path.join(dir, 'in.txt') })).rejects.toThrow(/\.json/);
    expect(query).not.toHaveBeenCalled();
  });
});
