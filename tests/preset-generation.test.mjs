import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPresetGenerationRequest, presetDefaultControls, presetWorkflowName } from '../src/runtime/preset-generation.mjs';

test('preset generation request maps workflow, parameters, overrides, and references', () => {
  const request = buildPresetGenerationRequest({
    id: 'preset_1',
    origin: 'chat',
    workflowName: 'preset.json',
    positive: 'portrait',
    negative: 'blur',
    parameters: { steps: 28, cfg: 6 },
    nodeOverrides: { '1': { seed: 123 } },
    sourceImages: [{ path: 'sources/preset_1/reference-001.png' }],
  }, { workflowName: 'current.json', controls: { settings: { width: 1024 }, nodeOverrides: { '2': { denoise: 0.7 } } } });
  assert.equal(request.workflowName, 'preset.json');
  assert.deepEqual(request.settings, { width: 1024, steps: 28, cfg: 6 });
  assert.deepEqual(request.nodeOverrides, { '2': { denoise: 0.7 }, '1': { seed: 123 } });
  assert.equal(request.origin, 'preset');
  assert.equal(request.presetOrigin, 'chat');
  assert.equal(request.media.images.length, 1);
});

test('preset generation accepts workflow and restores default controls', () => {
  const preset = { workflow: 'legacy.json', parameters: { steps: 20 }, nodeOverrides: { '3': { cfg: 5 } }, outputNodeIds: ['9'] };
  assert.equal(presetWorkflowName(preset, 'current.json'), 'legacy.json');
  assert.deepEqual(presetDefaultControls(preset), { settings: { steps: 20 }, nodeOverrides: { '3': { cfg: 5 } }, outputNodeIds: ['9'] });
  assert.equal(buildPresetGenerationRequest({ ...preset, positive: 'x' }, { workflowName: 'current.json' }).workflowName, 'legacy.json');
});
