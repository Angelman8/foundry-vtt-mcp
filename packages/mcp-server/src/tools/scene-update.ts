import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface SceneUpdateToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class SceneUpdateTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SceneUpdateToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SceneUpdateTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'update-scene',
        description:
          'Update fields of a scene, for example background.src, width, grid.size, darkness, name or navigation. Dot notation is allowed. Embedded documents (tokens, walls, lights, sounds, tiles, notes, drawings, templates, regions) are refused and have their own tools, as are _id, _stats, folder, ownership and flags.core.',
        inputSchema: {
          type: 'object',
          properties: {
            scene_identifier: { type: 'string', description: 'Scene id or exact name' },
            updates: {
              type: 'object',
              description: 'Scene fields to set, e.g. {"background.src": "maps/inn.webp"}',
            },
          },
          required: ['scene_identifier', 'updates'],
        },
      },
    ];
  }

  async handleUpdateScene(args: unknown): Promise<any> {
    const schema = z.object({
      scene_identifier: z.string().min(1),
      updates: z
        .record(z.unknown())
        .refine(u => Object.keys(u).length > 0, { message: 'updates must not be empty' }),
    });
    const parsed = schema.parse(args);
    this.logger.debug('Updating scene', { scene: parsed.scene_identifier });
    const result = await this.foundryClient.query('foundry-mcp-bridge.update-scene', parsed);
    if (result && (result.error || result.success === false)) {
      throw new Error(String(result.error ?? 'update-scene failed'));
    }
    return result;
  }
}
