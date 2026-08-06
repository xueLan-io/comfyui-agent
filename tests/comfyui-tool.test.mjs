import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { registerAdapters } from '../src/agent/tools/comfyui/adapters/index.mjs';

registerAdapters();

const minimalObjectInfo = {
  CLIPTextEncode: {
    output_node: false,
    input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] }, optional: {} },
    input_order: { required: ['clip', 'text'], optional: [] },
  },
};

test('fails loudly when a positive prompt cannot be injected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-agent-wf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'stuck.json'), JSON.stringify({
    nodes: [{
      id: 1,
      type: 'CLIPTextEncode',
      mode: 0,
      widgets_values: ['stored prompt'],
      inputs: [{ name: 'clip', link: -1 }],
      outputs: [],
    }],
    links: [],
  }));

  const original = ComfyUITool.client;
  ComfyUITool.setClient({ objectInfo: async () => minimalObjectInfo });
  try {
    await assert.rejects(
      ComfyUITool.execute({ workflowName: 'stuck.json', workflowDir: dir, prompt: 'a red cat' }),
      error => error.failureType === 'prompt_not_injected' && error.replan === true,
    );
  } finally {
    ComfyUITool.setClient(original);
  }
});

test('rejects a workflow before queueing when a referenced model is unavailable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-agent-wf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'missing-model.json'), JSON.stringify({
    nodes: [{
      id: 1,
      type: 'UNETLoader',
      mode: 0,
      inputs: [{ name: 'unet_name', widget: { name: 'unet_name' } }],
      widgets_values: ['missing.safetensors'],
    }],
    links: [],
  }));

  const original = ComfyUITool.client;
  ComfyUITool.setClient({
    objectInfo: async () => ({
      UNETLoader: {
        input: { required: { unet_name: [['installed.safetensors']] }, optional: {} },
        input_order: { required: ['unet_name'], optional: [] },
      },
    }),
  });
  try {
    await assert.rejects(
      ComfyUITool.execute({ workflowName: 'missing-model.json', workflowDir: dir }),
      error => error.failureType === 'model_missing' && error.message.includes('missing.safetensors'),
    );
  } finally {
    ComfyUITool.setClient(original);
  }
});

test('adaptation-only workflows fail with a preflight report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-agent-wf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'adapted.json'), JSON.stringify({
    nodes: [{ id: 1, type: 'MiniMaxH3ReferenceToVideo', mode: 0, inputs: [{ name: 'prompt' }] }],
    links: [],
  }));

  const original = ComfyUITool.client;
  ComfyUITool.setClient({ objectInfo: async () => ({}) });
  try {
    await assert.rejects(
      ComfyUITool.execute({ workflowName: 'adapted.json', workflowDir: dir }),
      error => error.failureType === 'adaptation_only'
        && error.preflight?.valid === false
        && error.preflight?.adaptationOnly === true,
    );
  } finally {
    ComfyUITool.setClient(original);
  }
});

test('recoverResult converts existing history into media results', async () => {
  const result = await ComfyUITool.recoverResult('prompt-1', {
    status: { completed: true, status_str: 'success' },
    outputs: { '1': { images: [{ filename: 'recovered.png', subfolder: '', type: 'output' }] } },
  });
  assert.equal(result.promptId, 'prompt-1');
  assert.equal(result.images[0].filename, 'recovered.png');
});
