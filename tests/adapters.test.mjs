import assert from 'node:assert/strict';
import test from 'node:test';
import { FluxAdapter } from '../src/agent/tools/comfyui/adapters/flux.mjs';
import { SDXLAdapter } from '../src/agent/tools/comfyui/adapters/sdxl.mjs';
import { AnimateDiffAdapter } from '../src/agent/tools/comfyui/adapters/animatediff.mjs';
import { WanAdapter } from '../src/agent/tools/comfyui/adapters/wan.mjs';

test('FluxAdapter.describe', () => {
  const wf = {
    nodes: [
      { type: 'FluxLoader', widgets_values: [1, 2, 3.5] },
      { type: 'easy promptList', widgets_values: ['prompt1'] },
    ],
  };
  const info = FluxAdapter.describe(wf);
  assert.equal(info.modelType, 'flux');
  assert.ok(info.fluxNodeTypes.includes('FluxLoader'));
  assert.equal(info.promptSlots, 1);
});

test('FluxAdapter.prepare sets guidance', () => {
  const wf = {
    nodes: [
      { type: 'FluxLoader', widgets_values: [1, 2, 3.0] },
      { type: 'EmptyLatentImage', widgets_values: [512, 512, 1] },
      { type: 'easy promptList', widgets_values: ['old'] },
    ],
  };
  FluxAdapter.prepare(wf, { prompt: 'new prompt', prompts: ['p1'], guidance: 7.5, size: '1024x768' });
  assert.equal(wf.nodes[2].widgets_values[0], 'old');
  assert.equal(wf.nodes[1].widgets_values[0], 768);
  assert.equal(wf.nodes[1].widgets_values[1], 1024);
  assert.equal(wf.nodes[0].widgets_values[2], 7.5);
});

test('SDXLAdapter.describe', () => {
  const wf = {
    nodes: [
      { type: 'CheckpointLoaderSimple', widgets_values: ['sd_xl_base.safetensors'] },
      { type: 'SDXLRefiner', widgets_values: [] },
    ],
  };
  const info = SDXLAdapter.describe(wf);
  assert.equal(info.modelType, 'sdxl');
  assert.equal(info.hasRefiner, true);
  assert.equal(info.checkpoint, 'sd_xl_base.safetensors');
});

test('SDXLAdapter.prepare sets resolution', () => {
  const wf = {
    nodes: [
      { type: 'EmptyLatentImage', widgets_values: [512, 512, 1] },
      { type: 'easy promptList', widgets_values: ['old'] },
    ],
  };
  SDXLAdapter.prepare(wf, { prompt: 'test', prompts: ['p1'], size: '1024x768' });
  assert.equal(wf.nodes[0].widgets_values[0], 768);
  assert.equal(wf.nodes[0].widgets_values[1], 1024);
  assert.equal(wf.nodes[1].widgets_values[0], 'old');
});

test('AnimateDiffAdapter.describe', () => {
  const wf = {
    nodes: [
      { type: 'AnimateDiffLoader', widgets_values: [] },
      { type: 'VideoOutput', widgets_values: [] },
    ],
  };
  const info = AnimateDiffAdapter.describe(wf);
  assert.equal(info.modelType, 'animatediff');
  assert.equal(info.hasVideoOutput, true);
});

test('AnimateDiffAdapter.prepare sets frames', () => {
  const wf = {
    nodes: [
      { type: 'EmptyLatentImage', widgets_values: [512, 512, 1] },
      { type: 'easy promptList', widgets_values: ['old'] },
    ],
  };
  AnimateDiffAdapter.prepare(wf, { prompt: 'animation', prompts: ['p1'], frames: 24 });
  assert.equal(wf.nodes[0].widgets_values[2], 24);
  assert.equal(wf.nodes[1].widgets_values[0], 'old');
});

test('AnimateDiffAdapter.prepare sets named frames and fps inputs', () => {
  const wf = {
    nodes: [
      { type: 'VideoLatent', inputs: [{ name: 'width' }, { name: 'height' }, { name: 'frames' }, { name: 'fps' }], widgets_values: [512, 512, 16, 8] },
    ],
  };
  AnimateDiffAdapter.prepare(wf, { frames: 48, fps: 24 });
  assert.equal(wf.nodes[0].widgets_values[2], 48);
  assert.equal(wf.nodes[0].widgets_values[3], 24);
});

test('WanAdapter.describe identifies video capabilities', () => {
  const info = WanAdapter.describe({ nodes: [
    { type: 'WanVideoSampler' },
    { type: 'VHS_VideoCombine' },
    { type: 'CLIPTextEncode' },
  ] });
  assert.equal(info.modelType, 'wan');
  assert.equal(info.supportsVideoOutput, true);
  assert.equal(info.promptSlots, 1);
});

test('WanAdapter.prepare sets named video controls', () => {
  const wf = { nodes: [{
    type: 'EmptyWanVideoLatent',
    inputs: [{ name: 'width' }, { name: 'height' }, { name: 'frames' }],
    widgets_values: [832, 480, 81],
  }, {
    type: 'VHS_VideoCombine',
    inputs: [{ name: 'frame_rate' }],
    widgets_values: [16],
  }] };
  WanAdapter.prepare(wf, { size: '1024x576', frames: 49, fps: 24 });
  assert.deepEqual(wf.nodes[0].widgets_values, [1024, 576, 49]);
  assert.equal(wf.nodes[1].widgets_values[0], 24);
});
