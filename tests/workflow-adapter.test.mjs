import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'node:path';
import { resolveWorkflowPath, WorkflowAdapter } from '../src/agent/tools/comfyui/workflow-adapter.mjs';
import { buildPromptProfile } from '../src/agent/tools/comfyui/prompt-profile.mjs';
import { registerAdapters } from '../src/agent/tools/comfyui/adapters/index.mjs';

registerAdapters();

test('MiniMax H3 reference workflow is identified as executable video after runtime preflight', async () => {
  const workflowDir = resolve('workflows');
  const result = await WorkflowAdapter.resolve('minimax_h3_amd_smoke.json', workflowDir);
  assert.equal(result.modelType, 'minimax_h3');
  assert.equal(result.adapter.name, 'minimax_h3');
  assert.equal(result.adapter.adaptationOnly, false);
  assert.ok(result.capabilities.modes.includes('txt2video'));
  assert.ok(result.capabilities.modes.includes('img2video'));
  assert.ok(result.capabilities.modes.includes('video2video'));
  assert.ok(result.info.referenceImageSlots >= 1);
  assert.equal(result.info.referenceVideoSlots, 3);
});

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'comfy-agent-wf-adapter-'));
}

test('resolveWorkflowPath valid path', () => {
  const result = resolveWorkflowPath('/base/workflows', 'test.json');
  assert.ok(result.endsWith('test.json'));
  assert.ok(result.includes('base'));
});

test('workflow capabilities distinguish image editing from text-to-image', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'inpaint.json'), JSON.stringify({
      nodes: [
        { id: 1, type: 'LoadImage', mode: 0 },
        { id: 2, type: 'LoadImageMask', mode: 0 },
        { id: 3, type: 'VAEEncodeForInpaint', mode: 0 },
      ],
    }));
    const result = await WorkflowAdapter.resolve('inpaint.json', dir);
    assert.deepEqual(result.capabilities.labels, ['generic_inpaint']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundled fixed workflows keep their required node paths', async () => {
  const expected = {
    'img2img.json': ['LoadImage', 'VAEEncode', 'KSampler', 'SaveImage'],
    'inpaint.json': ['LoadImage', 'LoadImageMask', 'VAEEncodeForInpaint', 'KSampler', 'SaveImage'],
    'upscale.json': ['LoadImage', 'ImageScaleBy', 'SaveImage'],
  };

  for (const [name, nodeTypes] of Object.entries(expected)) {
    const workflow = JSON.parse(readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8'));
    const types = new Set(workflow.nodes.map(node => node.type));
    for (const nodeType of nodeTypes) assert.ok(types.has(nodeType), `${name} is missing ${nodeType}`);
    assert.ok(workflow.links.length > 0, `${name} has no links`);
  }
});

test('resolveWorkflowPath rejects absolute', () => {
  assert.throws(() => resolveWorkflowPath('/base', '/etc/passwd'), /Invalid workflow filename/);
});

test('resolveWorkflowPath rejects traversal', () => {
  assert.throws(() => resolveWorkflowPath('/base', '../secret.json'), /outside/);
});

test('resolveWorkflowPath rejects non-json', () => {
  assert.throws(() => resolveWorkflowPath('/base', 'test.txt'), /Invalid workflow filename/);
});

test('WorkflowAdapter.detect identifies flux', () => {
  const wf = { nodes: [{ type: 'FluxLoader' }, { type: 'KSampler' }] };
  assert.equal(WorkflowAdapter.detect(wf), 'flux');
});

test('WorkflowAdapter.detect identifies sdxl', () => {
  const wf = { nodes: [{ type: 'SDXLCheckpoint' }] };
  assert.equal(WorkflowAdapter.detect(wf), 'sdxl');
});

test('WorkflowAdapter.detect identifies animatediff', () => {
  const wf = { nodes: [{ type: 'AnimateDiffLoader' }] };
  assert.equal(WorkflowAdapter.detect(wf), 'animatediff');
});

test('WorkflowAdapter resolves the bundled Wan video workflow', async () => {
  const dir = resolve('workflows');
  const result = await WorkflowAdapter.resolve('wan_txt2video.json', dir);
  assert.equal(result.modelType, 'wan');
  assert.ok(result.adapter);
  assert.ok(result.capabilities.modes.includes('txt2video'));
  assert.equal(result.info.supportsVideoOutput, true);
  assert.equal(result.info.supportsImageInput, false);
});

test('Wan adapter applies resolution, frames, FPS, and guidance from standard settings', async () => {
  const dir = resolve('workflows');
  const workflow = await WorkflowAdapter.prepareInput('wan_txt2video.json', dir, {
    settings: { width: 640, height: 360, frames: 49, fps: 12, cfg: 7 },
  });
  const latent = workflow.nodes.find(node => node.type === 'EmptyWanVideoLatent');
  const sampler = workflow.nodes.find(node => node.type === 'KSampler');
  const output = workflow.nodes.find(node => node.type === 'VHS_VideoCombine');
  assert.deepEqual(latent.widgets_values, [640, 360, 49, 1]);
  assert.equal(sampler.widgets_values[3], 7);
  assert.equal(output.widgets_values[0], 12);
});

test('detects Anima from active model artifacts before generic model types', () => {
  const wf = { nodes: [
    { id: 1, type: 'UNETLoader', mode: 0, widgets_values: ['miaomiaoHarem_anima14.safetensors'] },
    { id: 2, type: 'FluxLoader', mode: 4 },
  ] };
  assert.equal(WorkflowAdapter.detect(wf), 'anima');
});

test('builds prompt targets only from active sampler conditioning paths', () => {
  const wf = {
    nodes: [
      { id: 1, type: 'KSampler', mode: 0, inputs: [{ name: 'positive', link: 10 }, { name: 'negative', link: 11 }] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'text', link: 12 }], widgets_values: ['current positive'] },
      { id: 3, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'text' }], widgets_values: ['current negative'] },
      { id: 4, type: 'easy promptList', mode: 0, inputs: [{ name: 'prompt_1' }, { name: 'prompt_2' }] },
      { id: 5, type: 'easy promptList', mode: 0, inputs: [{ name: 'prompt_1' }] },
      { id: 6, type: 'UNETLoader', mode: 0, widgets_values: ['miaomiao_anima.safetensors'] },
      { id: 7, type: 'KSampler', mode: 4, inputs: [{ name: 'positive', link: 13 }] },
    ],
    links: [
      [10, 2, 0, 1, 1, 'CONDITIONING'],
      [11, 3, 0, 1, 2, 'CONDITIONING'],
      [12, 4, 0, 2, 1, 'STRING'],
      [13, 5, 0, 7, 1, 'CONDITIONING'],
    ],
  };

  assert.deepEqual(buildPromptProfile(wf), {
    family: 'anima',
    format: 'tag_narrative',
    positiveTargets: [{ nodeId: '2', input: 'text', type: 'CLIPTextEncode' }],
    negativeTargets: [{ nodeId: '3', input: 'text', type: 'CLIPTextEncode' }],
    promptLists: [{ nodeId: '4', inputs: ['prompt_1', 'prompt_2'] }],
    supportsNegative: true,
    currentPositive: 'current positive',
    currentNegative: 'current negative',
  });
});

test('WorkflowAdapter.detect generic fallback', () => {
  const wf = { nodes: [{ type: 'KSampler' }, { type: 'EmptyLatentImage' }] };
  assert.equal(WorkflowAdapter.detect(wf), 'generic');
});

test('WorkflowAdapter keeps nodes without mode active in mixed workflows', () => {
  const wf = { nodes: [
    { id: 1, type: 'KSampler' },
    { id: 2, type: 'EmptyLatentImage' },
    { id: 3, type: 'FluxLoader', mode: 4 },
  ] };
  assert.equal(WorkflowAdapter.detect(wf), 'generic');
});

test('workflow manifest describes Anima text-to-image capabilities and model files', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'anima.json'), JSON.stringify({
      nodes: [
        { id: 1, type: 'UNETLoader', mode: 0, inputs: [{ name: 'unet_name', widget: { name: 'unet_name' } }], widgets_values: ['anima.safetensors'] },
        { id: 2, type: 'CLIPLoader', mode: 0, inputs: [{ name: 'clip_name', widget: { name: 'clip_name' } }], widgets_values: ['anima-text.safetensors'] },
        { id: 3, type: 'VAELoader', mode: 0, inputs: [{ name: 'vae_name', widget: { name: 'vae_name' } }], widgets_values: ['qwen.vae.safetensors'] },
        { id: 4, type: 'EmptyLatentImage', mode: 0 },
        { id: 5, type: 'KSampler', mode: 0 },
      ],
    }));
    const result = await WorkflowAdapter.resolve('anima.json', dir);
    assert.deepEqual(result.capabilities.labels, ['anime_txt2img']);
    assert.deepEqual(result.modelRequirements.map(item => item.value), ['anima.safetensors', 'anima-text.safetensors', 'qwen.vae.safetensors']);
    assert.deepEqual(result.workflowProfile.resolution, null);
    assert.deepEqual(result.workflowProfile.recommendedParameters, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow profile records controlnet and upscale model requirements', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'guided-upscale.json'), JSON.stringify({
      nodes: [
        { id: 1, type: 'ControlNetLoader', mode: 0, inputs: [{ name: 'control_net_name', widget: { name: 'control_net_name' } }], widgets_values: ['openpose.safetensors'] },
        { id: 2, type: 'UpscaleModelLoader', mode: 0, inputs: [{ name: 'model_name', widget: { name: 'model_name' } }], widgets_values: ['anime-upscaler.pth'] },
        { id: 3, type: 'ImageScaleBy', mode: 0, inputs: [{ name: 'upscale_method', widget: { name: 'upscale_method' } }, { name: 'scale_by', widget: { name: 'scale_by' } }], widgets_values: ['lanczos', 2] },
      ],
    }));
    const result = await WorkflowAdapter.resolve('guided-upscale.json', dir);
    assert.deepEqual(result.capabilities.labels, ['controlnet_upscale']);
    assert.deepEqual(result.workflowProfile.controlnetFiles.map(item => item.value), ['openpose.safetensors']);
    assert.deepEqual(result.workflowProfile.upscaleModelFiles.map(item => item.value), ['anime-upscaler.pth']);
    assert.deepEqual(result.workflowProfile.resolution, { scaleBy: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow profile skips the legacy sampler seed control widget', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'legacy-sampler.json'), JSON.stringify({
      nodes: [{
        id: 1,
        type: 'KSampler',
        mode: 0,
        inputs: [
          { name: 'seed', widget: { name: 'seed' } },
          { name: 'steps', widget: { name: 'steps' } },
          { name: 'cfg', widget: { name: 'cfg' } },
          { name: 'sampler_name', widget: { name: 'sampler_name' } },
          { name: 'scheduler', widget: { name: 'scheduler' } },
          { name: 'denoise', widget: { name: 'denoise' } },
        ],
        widgets_values: [123, 'fixed', 12, 2, 'euler', 'simple', 0.65],
      }],
    }));
    const result = await WorkflowAdapter.resolve('legacy-sampler.json', dir);
    assert.deepEqual(result.workflowProfile.recommendedParameters, {
      steps: 12,
      cfg: 2,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 0.65,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
