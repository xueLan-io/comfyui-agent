import assert from 'node:assert/strict';
import test from 'node:test';
import { MiniMaxH3Adapter } from '../src/agent/tools/comfyui/adapters/minimax-h3.mjs';

function workflow() {
  return {
    nodes: [
      { type: 'UNETLoader', properties: { models: [{ name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', directory: 'diffusion_models' }] } },
      { type: 'VAELoader', properties: { models: [{ name: 'minimax_h3_video_vae_fp16.safetensors', directory: 'vae' }] } },
      { type: 'MiniMaxH3ReferenceToVideo', inputs: [
        { name: 'prompt' }, { name: 'width' }, { name: 'height' }, { name: 'length' },
        { name: 'ref_images.ref_image_0' }, { name: 'ref_videos.ref_video_0' },
      ], widgets_values: ['', 1344, 768, 124, 'match'] },
      { type: 'VHS_VideoCombine', inputs: [{ name: 'frame_rate' }], widgets_values: { frame_rate: 24 } },
    ],
  };
}

test('MiniMaxH3Adapter describes references, output, and required models', () => {
  const info = MiniMaxH3Adapter.describe(workflow());
  assert.equal(info.modelType, 'minimax_h3');
  assert.equal(info.supportsTextToVideo, true);
  assert.equal(info.supportsImageToVideo, true);
  assert.equal(info.supportsVideoReference, true);
  assert.equal(info.adaptationOnly, true);
  assert.equal(info.requiredModelFiles.length, 2);
});

test('MiniMaxH3Adapter patches H3 controls without executing', () => {
  const wf = workflow();
  const result = MiniMaxH3Adapter.prepare(wf, {
    prompt: 'a cinematic test',
    width: 832,
    height: 480,
    frames: 81,
    fps: 16,
  });
  assert.equal(result, wf);
  assert.deepEqual(wf.nodes[2].widgets_values.slice(0, 4), ['a cinematic test', 832, 480, 81]);
  assert.equal(wf.nodes[3].widgets_values.frame_rate, 16);
});

test('MiniMaxH3Adapter explicitly remains adaptation-only', () => {
  assert.equal(MiniMaxH3Adapter.adaptationOnly, true);
});
