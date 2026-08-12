import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';

const COMPLETED_ENTRY = {
  status: { status_str: 'success', completed: true, messages: [] },
  outputs: { '3': { images: [{ filename: 'img_00001_.png', subfolder: '', type: 'output' }] } },
};

class StubClient extends ComfyUIClient {
  constructor({ queue, history }) {
    super({ baseUrl: 'http://127.0.0.1:8188' });
    this._queue = queue;
    this._history = history;
  }

  async queue(opts = {}) {
    return this._queue(opts);
  }

  async history(promptId, opts = {}) {
    return this._history(promptId, opts);
  }
}

test('abort before polling salvages a completed history entry instead of cancelling', async () => {
  const client = new StubClient({
    queue: () => ({ queue_running: [], queue_pending: [] }),
    history: () => ({ 'p1': COMPLETED_ENTRY }),
  });
  const controller = new AbortController();
  controller.abort();

  const entry = await client.waitForCompletion('p1', 1000, controller.signal);
  assert.equal(entry, COMPLETED_ENTRY);
});

test('abort during the poll delay salvages a completed history entry', async () => {
  const client = new StubClient({
    queue: () => ({ queue_running: [['t1', 'p1']], queue_pending: [] }),
    history: () => ({ 'p1': COMPLETED_ENTRY }),
  });
  const controller = new AbortController();
  const promise = client.waitForCompletion('p1', 1000, controller.signal);
  setTimeout(() => controller.abort(), 40);

  const entry = await promise;
  assert.equal(entry, COMPLETED_ENTRY);
});

test('abort during a mid-flight queue fetch salvages a completed history entry', async () => {
  let abortedDuringFetch = false;
  const client = new StubClient({
    queue: opts => {
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => { abortedDuringFetch = true; }, { once: true });
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          setTimeout(resolve, 3000, { queue_running: [], queue_pending: [] });
        });
      }
      return { queue_running: [], queue_pending: [] };
    },
    history: () => ({ 'p1': COMPLETED_ENTRY }),
  });
  const controller = new AbortController();
  const promise = client.waitForCompletion('p1', 1000, controller.signal);
  setTimeout(() => controller.abort(), 40);

  const entry = await promise;
  assert.ok(abortedDuringFetch, 'abort should have fired during the queue fetch');
  assert.equal(entry, COMPLETED_ENTRY);
});

test('abort with no completed history entry still throws AbortError', async () => {
  const client = new StubClient({
    queue: () => ({ queue_running: [['t1', 'p1']], queue_pending: [] }),
    history: () => ({}),
  });
  const controller = new AbortController();
  const promise = client.waitForCompletion('p1', 1000, controller.signal);
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(promise, error => error.name === 'AbortError');
});

test('abort with an interrupted (non-success) history entry still throws AbortError', async () => {
  const client = new StubClient({
    queue: () => ({ queue_running: [['t1', 'p1']], queue_pending: [] }),
    history: () => ({
      'p1': {
        status: { status_str: 'interrupted', completed: true, messages: [['execution_interrupted', {}]] },
        outputs: {},
      },
    }),
  });
  const controller = new AbortController();
  const promise = client.waitForCompletion('p1', 1000, controller.signal);
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(promise, error => error.name === 'AbortError');
});

test('abort with a success entry but no media output still throws AbortError', async () => {
  const client = new StubClient({
    queue: () => ({ queue_running: [['t1', 'p1']], queue_pending: [] }),
    history: () => ({ 'p1': { status: { status_str: 'success', completed: true, messages: [] }, outputs: {} } }),
  });
  const controller = new AbortController();
  const promise = client.waitForCompletion('p1', 1000, controller.signal);
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(promise, error => error.name === 'AbortError');
});
