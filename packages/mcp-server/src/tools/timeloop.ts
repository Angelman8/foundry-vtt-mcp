import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface TimeloopToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const QUERY = 'foundry-mcp-bridge.timeloop';

const SCENE_NOTE =
  'Optional scene (id or name); the default is the scene the Timeloop clock is running on.';

const REFERENCES_NOTE =
  'Times: a number of loop seconds, or a clock string such as "09:30" or "09:30:15". ' +
  'Durations: a number is seconds; text such as "3m 20s" or "90s" (a bare number in text means minutes; a leading "-" goes backwards). ' +
  'A path reference is a string id or name, an object {token}, {wall}, {light}, {tile}, {actor} or {darkness: true}, or the string "cues". ' +
  'A change reference is an index (number), {time}, or a cue id (string).';

const ADD_CHANGE_NOTE =
  'Change fields by path kind (time is always required). ' +
  'token: at {x,y,elevation?,level?,rotation?,hidden?} to place, or path [{x,y}...] to walk with optional duration, action (walk, fly, swim, burrow, crawl, climb, jump, displace) and from; present (boolean). ' +
  'door: ds (closed, open, locked or 0-2). ' +
  'light: hidden, config {...light config}. ' +
  'tile: hidden, src, x, y. ' +
  'darkness: darkness (0-1), fade (boolean). ' +
  'actor stats: hp, statuses {dead: true}, set {"system.path": value}. ' +
  'cues: use timeloop-cue instead.';

const timeSchema = z.union([z.number(), z.string().min(1)]);
const refSchema = z.union([z.string().min(1), z.number(), z.record(z.unknown())]);
const pathSchema = z.union([z.string().min(1), z.record(z.unknown())]);
const sceneSchema = z.string().min(1).optional();

/** Add a zod issue for each field that is missing. */
function requireFields(
  data: Record<string, unknown>,
  fields: string[],
  ctx: z.RefinementCtx,
  operation: string
): void {
  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required for ${operation}`,
      });
    }
  }
}

const getSchema = z
  .object({
    what: z.enum(['clock', 'paths', 'path', 'state']),
    path: pathSchema.optional(),
    time: timeSchema.optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if (d.what === 'path') requireFields(d, ['path'], ctx, 'what=path');
  });

const createPathSchema = z
  .object({
    token: z.string().min(1).optional(),
    wall: z.string().min(1).optional(),
    light: z.string().min(1).optional(),
    tile: z.string().min(1).optional(),
    darkness: z.boolean().optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    // Counted as Timeloop counts them: only truthy values.
    const given = (['token', 'wall', 'light', 'tile', 'darkness'] as const).filter(k => d[k]);
    if (given.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Give exactly one of token, wall, light, tile or darkness',
      });
    }
  });

const editPathSchema = z
  .object({
    operation: z.enum(['rename', 'delete']),
    path: pathSchema,
    name: z.string().min(1).optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if (d.operation === 'rename') requireFields(d, ['name'], ctx, 'rename');
  });

const addChangeSchema = z.object({
  path: pathSchema,
  change: z.record(z.unknown()),
  scene: sceneSchema,
});

const editChangeSchema = z
  .object({
    operation: z.enum(['update', 'retime', 'remove']),
    path: pathSchema,
    change: refSchema,
    patch: z.record(z.unknown()).optional(),
    time: timeSchema.optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if (d.operation === 'update') requireFields(d, ['patch'], ctx, 'update');
    if (d.operation === 'retime') requireFields(d, ['time'], ctx, 'retime');
  });

const cueSchema = z
  .object({
    type: z.string().min(1),
    text: z.string().optional(),
    gmOnly: z.boolean().optional(),
    src: z.string().optional(),
    volume: z.number().optional(),
    macroUuid: z.string().optional(),
  })
  .strict();

const cueToolSchema = z
  .object({
    operation: z.enum(['add', 'remove']),
    cue: cueSchema.optional(),
    time: timeSchema.optional(),
    id: z.string().min(1).optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if (d.operation === 'add') requireFields(d, ['cue', 'time'], ctx, 'add');
    if (d.operation === 'remove') requireFields(d, ['id'], ctx, 'remove');
  });

const presenceSchema = z.object({
  operation: z.enum(['spawn', 'despawn']),
  token: z.string().min(1),
  time: timeSchema,
  // Timeloop validates the placement; extra fields (elevation, level, rotation, hidden) pass through.
  at: z.object({ x: z.number(), y: z.number() }).passthrough().optional(),
  scene: sceneSchema,
});

const clockSchema = z
  .object({
    operation: z.enum(['tick', 'jump', 'next', 'previous', 'reset', 'resume']),
    duration: timeSchema.optional(),
    time: timeSchema.optional(),
    keys: z.array(z.string()).optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if (d.operation === 'tick') requireFields(d, ['duration'], ctx, 'tick');
    if (d.operation === 'jump') requireFields(d, ['time'], ctx, 'jump');
  });

const exportSchema = z.object({
  file: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
  scene: sceneSchema,
});

const importSchema = z
  .object({
    data: z.union([z.string().min(1), z.record(z.unknown())]).optional(),
    file: z.string().min(1).optional(),
    scene: sceneSchema,
  })
  .superRefine((d, ctx) => {
    if ((d.data === undefined) === (d.file === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give exactly one of data or file' });
    }
  });

function checkJsonPath(file: string): void {
  if (!path.isAbsolute(file)) throw new Error(`file must be an absolute path: ${file}`);
  if (!file.toLowerCase().endsWith('.json')) throw new Error(`file must end in .json: ${file}`);
}

const sceneProp = { type: 'string', description: SCENE_NOTE };
const timeProp = {
  type: ['number', 'string'],
  description: 'Loop seconds, or a clock string such as "09:30"',
};
const pathProp = {
  type: ['string', 'object'],
  description:
    'Path id or name, {token}, {wall}, {light}, {tile}, {actor} (object with that key), {darkness: true}, or "cues"',
};

export class TimeloopTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: TimeloopToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'TimeloopTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'timeloop-get',
        description: `Read Timeloop state: the clock, the list of paths, one path, or the world state at a time. Requires the Timeloop module. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            what: { type: 'string', enum: ['clock', 'paths', 'path', 'state'] },
            path: {
              ...pathProp,
              description: `${pathProp.description}. Required when what is "path".`,
            },
            time: { ...timeProp, description: 'For what "state": the time to read (default: now)' },
            scene: sceneProp,
          },
          required: ['what'],
        },
      },
      {
        name: 'timeloop-create-path',
        description: `Create a Timeloop path (a track of changes) for a token, door, light, tile or the scene darkness. Give exactly one. ${SCENE_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Token name or id' },
            wall: { type: 'string', description: 'Wall id (must be a door)' },
            light: { type: 'string', description: 'Light id' },
            tile: { type: 'string', description: 'Tile id' },
            darkness: { type: 'boolean', description: 'true for the scene darkness path' },
            scene: sceneProp,
          },
        },
      },
      {
        name: 'timeloop-edit-path',
        description: `Rename or delete a Timeloop path. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['rename', 'delete'] },
            path: pathProp,
            name: { type: 'string', description: 'New name (rename only)' },
            scene: sceneProp,
          },
          required: ['operation', 'path'],
        },
      },
      {
        name: 'timeloop-add-change',
        description: `Add a change to a Timeloop path. ${ADD_CHANGE_NOTE} ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            path: pathProp,
            change: {
              type: 'object',
              description: 'The change: time plus the fields for the path kind',
              properties: { time: timeProp },
              required: ['time'],
            },
            scene: sceneProp,
          },
          required: ['path', 'change'],
        },
      },
      {
        name: 'timeloop-edit-change',
        description: `Update, retime or remove a change on a Timeloop path. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['update', 'retime', 'remove'] },
            path: pathProp,
            change: {
              type: ['number', 'string', 'object'],
              description: 'Change reference: index, {time}, or cue id',
            },
            patch: {
              type: 'object',
              description: 'Fields to change (update only); null removes a field',
            },
            time: { ...timeProp, description: 'New time (retime only)' },
            scene: sceneProp,
          },
          required: ['operation', 'path', 'change'],
        },
      },
      {
        name: 'timeloop-cue',
        description: `Add or remove a cue on the Timeloop timeline (chat, reminder, sound or macro). Macro cues run as the GM. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['add', 'remove'] },
            cue: {
              type: 'object',
              description:
                'For add: the cue. text is for chat and reminder, src for sound, macroUuid for macro',
              properties: {
                type: { type: 'string', enum: ['chat', 'reminder', 'sound', 'macro'] },
                text: { type: 'string' },
                gmOnly: { type: 'boolean' },
                src: { type: 'string' },
                volume: { type: 'number', description: '0 to 1' },
                macroUuid: { type: 'string' },
              },
              required: ['type'],
            },
            time: { ...timeProp, description: 'When the cue fires (add only)' },
            id: { type: 'string', description: 'Cue id (remove only)' },
            scene: sceneProp,
          },
          required: ['operation'],
        },
      },
      {
        name: 'timeloop-presence',
        description: `Make a token appear (spawn) or disappear (despawn) at a time on the Timeloop timeline. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['spawn', 'despawn'] },
            token: { type: 'string', description: 'Token name or id' },
            time: timeProp,
            at: {
              type: 'object',
              description: 'Where it appears (spawn only)',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y'],
            },
            scene: sceneProp,
          },
          required: ['operation', 'token', 'time'],
        },
      },
      {
        name: 'timeloop-clock',
        description: `Drive the Timeloop clock: tick forward by a duration, jump to a time, go to the next or previous change, reset the loop, or resume canon (optionally only for some keys). Returns the clock. ${SCENE_NOTE} ${REFERENCES_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['tick', 'jump', 'next', 'previous', 'reset', 'resume'],
            },
            duration: {
              type: ['number', 'string'],
              description:
                'tick only: a number of seconds, or text such as "3m 20s" or "90s" (a bare number in text means minutes)',
            },
            time: { ...timeProp, description: 'jump only: the time to jump to' },
            keys: {
              type: 'array',
              items: { type: 'string' },
              description: 'resume only: keys to resume (omit for all)',
            },
            scene: sceneProp,
          },
          required: ['operation'],
        },
      },
      {
        name: 'timeloop-export',
        description: `Export the scene's Timeloop timeline. With file (an absolute path ending .json) it writes the JSON there and returns {file, summary} instead of the data; an existing file is refused unless overwrite is true. ${SCENE_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Absolute path ending in .json' },
            overwrite: { type: 'boolean', default: false },
            scene: sceneProp,
          },
        },
      },
      {
        name: 'timeloop-import',
        description: `Import a Timeloop export into the scene. This replaces the scene's timeline without asking, and macro cues in the data will run as the GM. Give exactly one of data (the export object or its JSON text) or file (absolute path to a .json file). Returns {summary, warnings, missing}. ${SCENE_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            data: {
              type: ['object', 'string'],
              description: 'An export object, or its JSON text',
            },
            file: { type: 'string', description: 'Absolute path to a .json file' },
            scene: sceneProp,
          },
        },
      },
    ];
  }

  /** Send one call to the bridge and unwrap the envelope. */
  private async call(method: string, args: unknown[], scene?: string): Promise<any> {
    const payload = { method, args, scene: scene ?? null };
    this.logger.debug('Timeloop call', { method });
    const reply = await this.foundryClient.query(QUERY, payload);
    if (reply && reply.ok === true) return reply.result;
    if (reply && reply.ok === false && reply.error) {
      const { code, message, details } = reply.error;
      let text = `Timeloop ${code}: ${message}`;
      const hasDetails =
        details !== undefined &&
        details !== null &&
        !(typeof details === 'object' && Object.keys(details).length === 0);
      if (hasDetails) text += ` ${JSON.stringify(details)}`;
      throw new Error(text);
    }
    if (reply && typeof reply.error === 'string') {
      throw new Error(`Timeloop ${reply.error}`);
    }
    throw new Error('Timeloop: unexpected reply from the Foundry module');
  }

  async handleGet(args: unknown): Promise<any> {
    const a = getSchema.parse(args);
    switch (a.what) {
      case 'clock':
        return this.call('getClock', [], a.scene);
      case 'paths':
        return this.call('listPaths', [], a.scene);
      case 'path':
        return this.call('getPath', [a.path], a.scene);
      default:
        return this.call('stateAt', [a.time], a.scene);
    }
  }

  async handleCreatePath(args: unknown): Promise<any> {
    const { scene, ...spec } = createPathSchema.parse(args);
    return this.call('createPath', [spec], scene);
  }

  async handleEditPath(args: unknown): Promise<any> {
    const a = editPathSchema.parse(args);
    return a.operation === 'rename'
      ? this.call('renamePath', [a.path, a.name], a.scene)
      : this.call('deletePath', [a.path], a.scene);
  }

  async handleAddChange(args: unknown): Promise<any> {
    const a = addChangeSchema.parse(args);
    return this.call('addChange', [a.path, a.change], a.scene);
  }

  async handleEditChange(args: unknown): Promise<any> {
    const a = editChangeSchema.parse(args);
    switch (a.operation) {
      case 'update':
        return this.call('updateChange', [a.path, a.change, a.patch], a.scene);
      case 'retime':
        return this.call('retimeChange', [a.path, a.change, a.time], a.scene);
      default:
        return this.call('removeChange', [a.path, a.change], a.scene);
    }
  }

  async handleCue(args: unknown): Promise<any> {
    const a = cueToolSchema.parse(args);
    return a.operation === 'add'
      ? this.call('addCue', [a.cue, a.time], a.scene)
      : this.call('removeCue', [a.id], a.scene);
  }

  async handlePresence(args: unknown): Promise<any> {
    const a = presenceSchema.parse(args);
    return a.operation === 'spawn'
      ? this.call('spawn', [a.token, a.time, { at: a.at }], a.scene)
      : this.call('despawn', [a.token, a.time], a.scene);
  }

  async handleClock(args: unknown): Promise<any> {
    const a = clockSchema.parse(args);
    switch (a.operation) {
      case 'tick':
        return this.call('tick', [a.duration], a.scene);
      case 'jump':
        return this.call('jump', [a.time], a.scene);
      case 'next':
        return this.call('nextChange', [], a.scene);
      case 'previous':
        return this.call('previousChange', [], a.scene);
      case 'reset':
        return this.call('resetLoop', [], a.scene);
      default:
        return this.call('resumeCanon', [a.keys ?? null], a.scene);
    }
  }

  async handleExport(args: unknown): Promise<any> {
    const a = exportSchema.parse(args);
    if (a.file) checkJsonPath(a.file);
    const result = await this.call('exportTimeline', [], a.scene);
    if (!a.file) return result;

    let paths = 0;
    let changes = 0;
    let cues = 0;
    for (const track of result?.timeline?.tracks ?? []) {
      const n = track?.keys?.length ?? 0;
      if (track?.kind === 'cue') cues += n;
      else {
        paths++;
        changes += n;
      }
    }
    try {
      await writeFile(a.file, JSON.stringify(result, null, 2), {
        encoding: 'utf8',
        flag: a.overwrite ? 'w' : 'wx',
      });
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        throw new Error(`File already exists (pass overwrite: true to replace it): ${a.file}`);
      }
      throw error;
    }
    return { file: a.file, summary: { paths, changes, cues } };
  }

  async handleImport(args: unknown): Promise<any> {
    const a = importSchema.parse(args);
    let data = a.data;
    if (a.file) {
      checkJsonPath(a.file);
      // Windows tools often write UTF-8 with a byte order mark, which JSON.parse refuses.
      data = (await readFile(a.file, 'utf8')).replace(/^﻿/, '');
    }
    return this.call('importTimeline', [data], a.scene);
  }
}
