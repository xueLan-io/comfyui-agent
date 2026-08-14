import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParameterSchema } from '../src/runtime/parameter-schema.mjs';
import { mergePresetOverrides, parseParameterOverrides } from '../src/runtime/preset-overrides.mjs';

test('parameter schema derives sliders, selects, and model fields from a workflow manifest', () => {
  const schema = buildParameterSchema({
    commonSettings: { steps: 28, cfg: 6 },
    editableNodes: [{ id: '4', inputs: [
      { name: 'sampler_name', value: 'euler', options: ['euler', 'ddim'] },
      { name: 'ckpt_name', value: 'model.safetensors', options: ['model.safetensors', 'model-v2.safetensors'] },
    ] }],
  });
  assert.equal(schema.find(item => item.key === 'steps').type, 'number');
  assert.equal(schema.find(item => item.key === 'steps').max, 150);
  assert.equal(schema.find(item => item.key === 'sampler_name').type, 'select');
  assert.equal(schema.find(item => item.key === 'ckpt_name').type, 'select');
});

test('parameter schema tolerates a null manifest (no workflow selected)', () => {
  assert.deepEqual(buildParameterSchema(null), []);
  assert.deepEqual(buildParameterSchema(undefined), []);
});

test('preset override layers merge with predictable precedence', () => {
  assert.deepEqual(mergePresetOverrides(
    { settings: { steps: 20, cfg: 5 } },
    { parameters: { steps: 28 } },
    { settings: { steps: 32 }, outputNodeIds: ['9'] },
  ), { settings: { steps: 32, cfg: 5 }, nodeOverrides: {}, outputNodeIds: ['9'] });
  assert.deepEqual(parseParameterOverrides('{"steps": 30}'), { steps: 30 });
  assert.throws(() => parseParameterOverrides('[]'), /JSON 对象/);
});
