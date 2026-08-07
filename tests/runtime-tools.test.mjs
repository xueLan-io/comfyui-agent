import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { ComfyUIGetQueueTool, ComfyUIGetStatusTool, ComfyUIGetOutputTool, ComfyUICancelPromptTool, ComfyUIInterruptTool } from '../src/agent/tools/comfyui/runtime.mjs';

async function withClient(mock, fn) { const original = ComfyUITool.client; ComfyUITool.setClient(mock); try { return await fn(); } finally { ComfyUITool.setClient(original); } }

test('runtime queue and status normalize results and preserve partial stats', async () => {
  await withClient({ queue: async () => ({ queue_running: [['x', 'run']], queue_pending: [['y', 'wait']], extra: true }), systemStats: async () => { throw new Error('offline'); } }, async () => {
    const queue = await ComfyUIGetQueueTool.execute({}); assert.deepEqual(queue.running_ids, ['run']); assert.equal(queue.counts.pending, 1);
    const status = await ComfyUIGetStatusTool.execute({}); assert.equal(status.reachable, true); assert.equal(status.system, null); assert.deepEqual(status.warnings, ['system_stats_unavailable']);
  });
});

test('runtime mutations require confirmation and explicit targets', async () => {
  let calls = 0; const mock = { queueDelete: async () => { calls += 1; }, interrupt: async () => { calls += 1; } };
  await withClient(mock, async () => {
    assert.equal((await ComfyUICancelPromptTool.execute({ promptId: 'x' })).code, 'confirmation_required');
    assert.equal((await ComfyUIInterruptTool.execute({ confirmation: true })).code, 'target_required');
    assert.equal(calls, 0);
    const result = await ComfyUICancelPromptTool.execute({ promptId: 'x', confirmation: true }); assert.deepEqual(result.deletedIds, ['x']); assert.equal(calls, 2);
  });
});

test('output tool extracts references and does not data-url videos', async () => {
  const calls = []; const mock = { history: async () => ({ p: { outputs: { '1': { images: [{ filename: 'a.png' }], videos: [{ filename: 'v.mp4' }] } } } }), inspectImage: async ref => ({ filename: ref.filename, exists: true }), imageDataUrl: async ref => { calls.push(ref.filename); return 'data:image/png;base64,AA'; } };
  await withClient(mock, async () => { const result = await ComfyUIGetOutputTool.execute({ promptId: 'p', mode: 'data_url' }); assert.equal(result.count, 2); assert.deepEqual(calls, ['a.png']); });
});
