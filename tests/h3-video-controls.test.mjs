import assert from 'node:assert/strict';
import test from 'node:test';
import { H3_AMD_CONTROLS, H3_HARDWARE_CONTROLS, H3_NVIDIA_CONTROLS, isMiniMaxH3Workflow } from '../src/components/h3-video-controls.mjs';

test('H3 video card exposes NVIDIA and AMD five-second presets', () => {
  assert.deepEqual(H3_AMD_CONTROLS.settings, { width: 640, height: 352, frames: 124, fps: 24, steps: 20, cfg: 5, batch: 1 });
  assert.deepEqual(H3_NVIDIA_CONTROLS.settings, { width: 832, height: 480, frames: 124, fps: 24, steps: 24, cfg: 5, batch: 1 });
  assert.equal(H3_HARDWARE_CONTROLS.nvidia, H3_NVIDIA_CONTROLS);
  assert.equal(H3_HARDWARE_CONTROLS.amd, H3_AMD_CONTROLS);
  assert.deepEqual(H3_AMD_CONTROLS.nodeOverrides, {});
  assert.deepEqual(H3_NVIDIA_CONTROLS.nodeOverrides, {});
  assert.equal(JSON.stringify(H3_AMD_CONTROLS).includes('9060'), false);
});

test('H3 video card is limited to MiniMax H3 workflow manifests', () => {
  assert.equal(isMiniMaxH3Workflow({ modelType: 'minimax_h3' }), true);
  assert.equal(isMiniMaxH3Workflow({ promptProfile: { family: 'minimax_h3' } }), true);
  assert.equal(isMiniMaxH3Workflow({ modelType: 'wan' }), false);
});
