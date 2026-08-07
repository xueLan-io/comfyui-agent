import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentProcessClient } from '../electron/agent-process.mjs';
import { TaskStore } from '../src/runtime/task-store.mjs';
import { createFakeClock } from './harness/fake-clock.mjs';
import { createFakeComfyUI } from './harness/fake-comfyui.mjs';
import { createFakeIpc } from './harness/fake-ipc.mjs';
import { createTempDataDir } from './harness/temp-data-dir.mjs';

test('Phase 10 harnesses provide deterministic clock, IPC, and ComfyUI task events', async () => {
  const clock = createFakeClock(10);
  const calls = [];
  const timer = clock.setTimeout(() => calls.push('timer'), 5);
  clock.tick(4);
  assert.deepEqual(calls, []);
  clock.tick(1);
  assert.deepEqual(calls, ['timer']);
  clock.clearTimeout(timer);

  const ipc = createFakeIpc();
  ipc.handle('diagnostic:echo', (_, input) => ({ ...input, source: 'harness' }));
  assert.deepEqual(await ipc.invoke('diagnostic:echo', { requestId: 'r-1' }), { requestId: 'r-1', source: 'harness' });

  const comfy = createFakeComfyUI();
  const progress = [];
  const off = comfy.onProgress(event => progress.push(event.data));
  const { promptId } = await comfy.submit({ '1': { class_type: 'KSampler' } }, 'client-1');
  comfy.start(promptId);
  comfy.emitProgress(promptId, 5, 20);
  comfy.complete(promptId);
  off();
  assert.equal((await comfy.queue()).queue_running.length, 0);
  assert.equal((await comfy.history(promptId))[promptId].status.status_str, 'success');
  assert.deepEqual(progress, [{ prompt_id: promptId, value: 5, max: 20, node: 'KSampler' }]);
});

test('RPC timeout cancels only an explicitly task-scoped request', async () => {
  const client = new AgentProcessClient({ rpcTimeoutMs: 10 });
  const sent = [];
  client.ready = Promise.resolve();
  client.child = {
    connected: true,
    send(message, callback) {
      sent.push(message);
      callback?.();
      if (message.method === 'cancel') queueMicrotask(() => client._handleMessage({ type: 'response', id: message.id, ok: true, result: { cancelled: true } }));
    },
  };

  await assert.rejects(() => client.call('handleTurn', [{ taskId: 'task-1', message: 'make an image' }]), error => error.code === 'AGENT_RPC_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(sent.map(message => message.method), ['handleTurn', 'cancel']);
  assert.deepEqual(sent[1].args, ['task-1']);

  sent.length = 0;
  await assert.rejects(() => client.call('chat', ['ordinary chat text']), error => error.code === 'AGENT_RPC_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(sent.map(message => message.method), ['chat']);
});

test('task store serializes concurrent writes in an isolated data directory', async t => {
  const data = await createTempDataDir('comfy-phase10-store-');
  t.after(data.dispose);
  const filePath = join(data.dir, 'tasks.json');
  const store = new TaskStore(filePath);
  store.put({ id: 'first', state: 'queued' });
  store.put({ id: 'second', state: 'observing' });
  await store.flush();
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(stored.map(task => task.id).sort(), ['first', 'second']);
  assert.equal((await new TaskStore(filePath).load()).get('second').state, 'observing');
});
