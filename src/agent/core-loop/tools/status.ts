import { z } from 'zod';

import { toCompactError } from '../comfy/errors.ts';
import { defineTool } from './types.ts';

/**
 * Orientation tools.
 *
 * `server_status` is the intended first call of a run: it is cheap, confirms the
 * server is reachable, and reports the obvious preconditions (queue depth, GPU
 * memory) so a failure can be explained rather than just observed.
 */
export const serverStatus = defineTool({
  name: 'server_status',
  description:
    'Check that the ComfyUI server is reachable and report its state: ComfyUI/Python ' +
    'version, available devices and GPU memory, and the current queue depth. Call this ' +
    'first to confirm the server is up. Also reports how many node classes are available, ' +
    'without listing them.',
  schema: z.object({}),
  mutating: false,
  handler: async (_input, ctx) => {
    try {
      const [stats, queue] = await Promise.all([
        ctx.comfy.getSystemStats(),
        ctx.comfy.getQueue().catch(() => ({ queue_running: [], queue_pending: [] })),
      ]);

      // Loading the catalogue here is worth its cost: it warms the index the
      // rest of the run depends on, and it turns "server reachable" into
      // "server reachable AND usable", which is the question that matters.
      let nodeCount: number | undefined;
      try {
        nodeCount = (await ctx.catalog.ensure()).size;
      } catch {
        nodeCount = undefined;
      }

      const devices = (stats.devices ?? []).map((device) => ({
        name: device['name'],
        type: device['type'],
        vram_total_mb:
          typeof device['vram_total'] === 'number'
            ? Math.round((device['vram_total'] as number) / (1024 * 1024))
            : undefined,
        vram_free_mb:
          typeof device['vram_free'] === 'number'
            ? Math.round((device['vram_free'] as number) / (1024 * 1024))
            : undefined,
      }));

      const running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0;
      const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0;

      ctx.note(`Server reachable: ${nodeCount ?? '?'} node classes, ${running + pending} queued.`);

      return {
        ok: true,
        content: {
          reachable: true,
          comfyui_version: stats.system?.['comfyui_version'],
          python_version: stats.system?.['python_version'],
          os: stats.system?.['os'],
          devices,
          queue: { running, pending },
          node_class_count: nodeCount,
          dry_run: ctx.policy.dryRun,
        },
      };
    } catch (error) {
      const compact = toCompactError(error, 'SERVER_UNREACHABLE');
      return { ok: false, errorCode: compact.code, content: compact };
    }
  },
});

export const getQueue = defineTool({
  name: 'get_queue',
  description:
    'Report the ComfyUI execution queue: how many jobs are running and how many are ' +
    'pending. Use this to explain a long wait, or to check whether an earlier submission ' +
    'is still in flight.',
  schema: z.object({}),
  mutating: false,
  handler: async (_input, ctx) => {
    try {
      const queue = await ctx.comfy.getQueue();
      return {
        ok: true,
        content: {
          running: Array.isArray(queue.queue_running) ? queue.queue_running.length : 0,
          pending: Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0,
        },
      };
    } catch (error) {
      const compact = toCompactError(error, 'QUEUE_LOOKUP_FAILED');
      return { ok: false, errorCode: compact.code, content: compact };
    }
  },
});
