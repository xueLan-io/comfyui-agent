import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { ComfyUIClient, queueContains } from '../src/agent/tools/comfyui/client.mjs';

test('queueContains matches promptId in running', () => {
  const items = [['1', 'prompt-abc'], ['2', 'prompt-def']];
  assert.equal(queueContains(items, 'prompt-abc'), true);
});

test('queueContains matches promptId in pending', () => {
  const items = [['1', 'prompt-xyz']];
  assert.equal(queueContains(items, 'prompt-xyz'), true);
});

test('queueContains returns false for missing id', () => {
  const items = [['1', 'prompt-abc']];
  assert.equal(queueContains(items, 'prompt-other'), false);
});

test('queueContains handles empty array', () => {
  assert.equal(queueContains([], 'prompt-abc'), false);
});

test('queueContains handles null items', () => {
  assert.equal(queueContains(null, 'prompt-abc'), false);
});

test('ComfyUIClient normalizes baseUrl', () => {
  const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188/' });
  assert.equal(client.baseUrl, 'http://localhost:8188');
});

test('ComfyUIClient rejects non-http protocol', () => {
  assert.throws(() => new ComfyUIClient({ baseUrl: 'ftp://localhost' }), /http or https/);
});

test('ComfyUIClient aborts a stalled request', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188', requestTimeoutMs: 10 });
    await assert.rejects(client.request('/system_stats'), /timed out/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('submit normalizes prompt id and marks an uncertain network response', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188' });
  client.queuePrompt = async () => ({ prompt_id: 'prompt-1' });
  assert.deepEqual(await client.submit({}, 'client-1'), { promptId: 'prompt-1' });

  client.queuePrompt = async () => { throw new Error('ComfyUI request timed out'); };
  await assert.rejects(client.submit({}, 'client-1'), error => error.failureType === 'submit_unknown');
});

test('observe and fetchResult use an existing prompt id', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188' });
  client.waitForCompletion = async promptId => ({ promptId, outputs: {} });
  client.history = async promptId => ({ [promptId]: { outputs: { '1': {} } } });

  assert.equal((await client.observe('prompt-1')).promptId, 'prompt-1');
  assert.ok((await client.fetchResult('prompt-1')).outputs);
});

test('waitForCompletion stops immediately when the task is cancelled', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188' });
  client.queue = async () => ({ queue_running: [['1', 'prompt-abc']], queue_pending: [] });
  client.history = async () => ({});
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.waitForCompletion('prompt-abc', 1000, controller.signal),
    error => error.name === 'AbortError',
  );
});

test('openProgressSocket forwards ComfyUI sampling progress', async () => {
  const previousWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.handlers = new Map();
      sockets.push(this);
    }

    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    }

    close() {}

    emit(type, event = {}) {
      this.handlers.get(type)?.(event);
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const client = new ComfyUIClient({ baseUrl: 'http://localhost:8188' });
    const progress = [];
    const socketPromise = client.openProgressSocket('client-1', {
      '7': { class_type: 'KSampler', inputs: {} },
    }, value => progress.push(value));
    sockets[0].emit('open');
    sockets[0].emit('message', {
      data: JSON.stringify({ type: 'progress', data: { node: '7', value: 4, max: 20 } }),
    });
    await socketPromise;

    assert.deepEqual(progress[0], {
      stage: 'sampling',
      nodeId: '7',
      nodeType: 'KSampler',
      value: 4,
      max: 20,
      percent: 20,
      message: 'KSampler 4/20',
    });
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test('openProgressSocket falls back to a node websocket client', async () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      const payload = Buffer.from(JSON.stringify({
        type: 'progress',
        data: { node: '3', value: 2, max: 8 },
      }));
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const client = new ComfyUIClient({ baseUrl: `http://127.0.0.1:${port}` });
    const progress = [];
    const socket = await client.openProgressSocket('client-2', {
      '3': { class_type: 'KSampler', inputs: {} },
    }, value => progress.push(value));

    assert.equal(progress[0].percent, 25);
    socket.close();
  } finally {
    globalThis.WebSocket = previousWebSocket;
    await new Promise(resolve => server.close(resolve));
  }
});
