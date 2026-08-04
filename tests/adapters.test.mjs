import assert from 'node:assert/strict';
import test from 'node:test';
import { FluxAdapter } from '../src/agent/tools/comfyui/adapters/flux.mjs';
import { SDXLAdapter } from '../src/agent/tools/comfyui/adapters/sdxl.mjs';
import { AnimateDiffAdapter } from '../src/agent/tools/comfyui/adapters/animatediff.mjs';

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
