import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRuntimeParameters, freezeRuntimeRequest, runtimeRequestDigest, createRuntimeDiff } from '../src/runtime/runtime-parameters-contract.mjs';

test('runtime request canonicalization converts numbers and deep freezes independently', () => {
  const input = { workflowName: 'txt2img.json', workflowDir: 'workflows', prompt: 'cat', settings: { seed: '42', steps: '30', cfg: 6.5 }, nodeOverrides: { '3': { text: 'x' } }, images: ['D:/ref.png'] };
  const request = normalizeRuntimeParameters(input); const frozen = freezeRuntimeRequest(request); input.settings.seed = 99; request.nodeOverrides['3'].text = 'changed';
  assert.equal(frozen.settings.seed, 42); assert.equal(frozen.nodeOverrides['3'].text, 'x'); assert.equal(frozen.media.images[0].name, 'ref.png');
  assert.equal(runtimeRequestDigest(frozen), runtimeRequestDigest(freezeRuntimeRequest(frozen)));
});

test('runtime request rejects invalid bounded values and shapes', () => {
  assert.throws(() => normalizeRuntimeParameters({ workflowName: 'x.json', workflowDir: 'x', settings: { steps: 0 } }), /steps/);
  assert.throws(() => normalizeRuntimeParameters({ workflowName: 'x.json', workflowDir: 'x', settings: { cfg: 'NaN' } }), /cfg/);
  assert.throws(() => normalizeRuntimeParameters({ workflowName: 'x.json', workflowDir: 'x', nodeOverrides: { '1': [] } }), /nodeOverrides/);
  assert.throws(() => normalizeRuntimeParameters({ workflowName: 'x.json', workflowDir: 'x', settings: { frames: 0 } }), /frames/);
  assert.throws(() => normalizeRuntimeParameters({ workflowName: 'x.json', workflowDir: 'x', settings: { fps: 241 } }), /fps/);
});

test('runtime request canonicalizes top-level video controls into settings', () => {
  const request = normalizeRuntimeParameters({ workflowName: 'wan.json', workflowDir: 'workflows', prompt: 'a cat', frames: '81', fps: '16' });
  assert.deepEqual(request.settings, { denoise: 1, batch: 1, frames: 81, fps: 16 });
});

test('runtime diff reports node input and removed output changes', () => {
  const before = { '1': { inputs: { steps: 20 } }, '2': { inputs: { image: 'x' } } };
  const after = { '1': { inputs: { steps: 30 } } };
  assert.deepEqual(createRuntimeDiff(before, after), [
    { kind: 'node_input', nodeId: '1', input: 'steps', from: 20, to: 30 },
    { kind: 'output', nodeId: '2', from: 'present', to: 'removed' },
  ]);
});
