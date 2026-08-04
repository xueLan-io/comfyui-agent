import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { SystemTool } from '../src/agent/tools/system/index.mjs';

const mockClient = {
  async queue() {
    return { queue_running: [['1', 'prompt-running']], queue_pending: [['2', 'prompt-pending']] };
  },
  async objectInfo() {
    return {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux.safetensors', 'sd_xl.safetensors'], {}] } } },
      LoraLoader: { input: { required: { lora_name: [['detail.safetensors'], {}] } } },
      SomeNode: { input: { required: { value: ['INT', { min: 0 }] } } },
    };
  },
  async systemStats() {
    return {
      devices: [{ name: 'NVIDIA RTX 4090', type: 'cuda', vram_total: 1000, vram_free: 400 }],
      system: { os: 'windows', ram_total: 100, ram_free: 30 },
    };
  },
};

const failingClient = {
  async queue() {
    throw new Error('connection refused');
  },
  async objectInfo() {
    throw new Error('connection refused');
  },
  async systemStats() {
    throw new Error('connection refused');
  },
};

function withClient(client, fn) {
  const original = ComfyUITool.client;
  ComfyUITool.setClient(client);
  try {
    return fn();
  } finally {
    ComfyUITool.setClient(original);
  }
}

test('status reports running and pending queue counts', async () => {
  const result = await withClient(mockClient, () => SystemTool.execute({ action: 'status' }));
  assert.equal(result.reachable, true);
  assert.deepEqual(result.queue, {
    running: 1,
    pending: 1,
    runningPromptIds: ['prompt-running'],
    pendingPromptIds: ['prompt-pending'],
  });
});

test('queue reports running and pending prompt ids', async () => {
  const result = await withClient(mockClient, () => SystemTool.execute({ action: 'queue' }));
  assert.equal(result.reachable, true);
  assert.equal(result.action, 'queue');
  assert.deepEqual(result.queue, {
    running: 1,
    pending: 1,
    runningPromptIds: ['prompt-running'],
    pendingPromptIds: ['prompt-pending'],
  });
});

test('models extracts checkpoints and loras from object_info', async () => {
  const result = await withClient(mockClient, () => SystemTool.execute({ action: 'models' }));
  assert.equal(result.reachable, true);
  assert.deepEqual(result.models.checkpoints, ['flux.safetensors', 'sd_xl.safetensors']);
  assert.deepEqual(result.models.loras, ['detail.safetensors']);
  assert.equal(result.models.vae, undefined);
});

test('device summarizes vram from system_stats', async () => {
  const result = await withClient(mockClient, () => SystemTool.execute({ action: 'device' }));
  assert.equal(result.reachable, true);
  assert.equal(result.device.devices[0].name, 'NVIDIA RTX 4090');
  assert.equal(result.device.devices[0].vramTotal, 1000);
  assert.equal(result.device.ramFree, 30);
});

test('unreachable ComfyUI returns reachable false with error', async () => {
  const result = await withClient(failingClient, () => SystemTool.execute({ action: 'status' }));
  assert.equal(result.reachable, false);
  assert.ok(result.error.includes('connection refused'));
});

test('search_models lists and filters model files with family detection', async () => {
  const client = {
    async modelList(folder) {
      const files = {
        checkpoints: ['flux-fp8.safetensors', 'anima-v2.safetensors'],
        loras: ['detail-lora.safetensors'],
      };
      return files[folder] || [];
    },
    async objectInfo() {
      return {};
    },
  };
  const all = await withClient(client, () => SystemTool.execute({ action: 'search_models' }));
  assert.equal(all.total, 3);

  const flux = await withClient(client, () => SystemTool.execute({ action: 'search_models', query: 'flux' }));
  assert.equal(flux.results.length, 1);
  assert.equal(flux.results[0].family, 'flux');

  const byKind = await withClient(client, () => SystemTool.execute({ action: 'search_models', kind: 'loras' }));
  assert.equal(byKind.results.length, 1);
  assert.equal(byKind.results[0].file, 'detail-lora.safetensors');

  const anima = await withClient(client, () => SystemTool.execute({ action: 'search_models', family: 'anima' }));
  assert.equal(anima.results.length, 1);
  assert.equal(anima.results[0].file, 'anima-v2.safetensors');
});

test('search_models falls back to object_info when the endpoint is unavailable', async () => {
  const client = {
    async modelList() {
      throw new Error('not found');
    },
    async objectInfo() {
      return {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux.safetensors', 'sd_xl.safetensors'], {}] } } },
      };
    },
  };
  const result = await withClient(client, () => SystemTool.execute({ action: 'search_models', query: 'xl' }));
  assert.equal(result.usedFallback, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].file, 'sd_xl.safetensors');
});

test('log returns history entries with failure details and traceback', async () => {
  const client = {
    async historyRecent() {
      return {
        'p1': { prompt: [5, 'p1'], status: { completed: true, status_str: 'success', messages: [['execution_success', {}]] }, outputs: { '9': { images: [] } } },
        'p2': {
          prompt: [5, 'p2'],
          status: {
            completed: true,
            status_str: 'error',
            messages: [[
              'execution_error',
              { node_id: 9, node_type: 'KSampler', exception_type: 'RuntimeError', exception_message: 'CUDA out of memory', traceback: ['line1', 'line2', 'line3'] },
            ]],
          },
        },
      };
    },
  };
  const result = await withClient(client, () => SystemTool.execute({ action: 'log', limit: 5 }));
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].failed, false);
  assert.equal(result.entries[1].failed, true);
  assert.equal(result.entries[1].error.nodeType, 'KSampler');
  assert.equal(result.entries[1].error.exceptionMessage, 'CUDA out of memory');
  assert.deepEqual(result.entries[1].error.traceback, ['line1', 'line2', 'line3']);
});
