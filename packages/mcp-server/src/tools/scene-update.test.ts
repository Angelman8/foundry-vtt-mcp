import { describe, expect, it, vi } from 'vitest';
import { SceneUpdateTools } from './scene-update.js';

function makeTools(reply: any = { success: true, sceneId: 's1', sceneName: 'Inn', changed: {} }) {
  const query = vi.fn().mockResolvedValue(reply);
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new SceneUpdateTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('update-scene', () => {
  it('sends the query name and payload and returns the bridge result', async () => {
    const { tools, query } = makeTools({ success: true, sceneId: 's1', changed: { width: 10 } });
    const result = await tools.handleUpdateScene({
      scene_identifier: 'Inn',
      updates: { 'background.src': 'maps/inn.webp' },
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.update-scene', {
      scene_identifier: 'Inn',
      updates: { 'background.src': 'maps/inn.webp' },
    });
    expect(result).toEqual({ success: true, sceneId: 's1', changed: { width: 10 } });
  });

  it('refuses empty or missing updates before any query', async () => {
    const { tools, query } = makeTools();
    await expect(
      tools.handleUpdateScene({ scene_identifier: 'Inn', updates: {} })
    ).rejects.toThrow();
    await expect(tools.handleUpdateScene({ scene_identifier: 'Inn' })).rejects.toThrow();
    await expect(tools.handleUpdateScene({ updates: { a: 1 } })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('turns Access denied into an error', async () => {
    const { tools } = makeTools({ error: 'Access denied', success: false });
    await expect(
      tools.handleUpdateScene({ scene_identifier: 'Inn', updates: { name: 'x' } })
    ).rejects.toThrow('Access denied');
  });

  it('advertises one tool named update-scene', () => {
    const { tools } = makeTools();
    expect(tools.getToolDefinitions().map((t: any) => t.name)).toEqual(['update-scene']);
  });
});
