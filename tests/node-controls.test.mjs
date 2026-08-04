import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countControlChanges,
  parseControlValue,
  setNodeControl,
  setSettingControl,
  toggleOutputControl,
} from '../src/components/node-controls.mjs';

const controls = () => ({ settings: {}, nodeOverrides: {}, outputNodeIds: null });

test('keeps text controls as strings and parses numeric and boolean controls', () => {
  assert.equal(parseControlValue({ type: 'text', value: 'euler' }, 'dpmpp_2m'), 'dpmpp_2m');
  assert.equal(parseControlValue({ type: 'number', value: 20 }, '12'), 12);
  assert.equal(parseControlValue({ type: 'boolean', value: false }, 'true'), true);
  assert.equal(parseControlValue({ type: 'number', value: 20 }, ''), undefined);
});

test('removes reset settings and empty node override groups', () => {
  let next = setSettingControl(controls(), 'steps', 12);
  next = setNodeControl(next, '10', 'sampler_name', 'euler');
  assert.equal(countControlChanges(next), 2);

  next = setSettingControl(next, 'steps', undefined);
  next = setNodeControl(next, '10', 'sampler_name', undefined);
  assert.deepEqual(next, controls());
});

test('selects output branches explicitly and never disables the last output', () => {
  const outputs = [{ id: '2' }, { id: '3' }];
  let next = toggleOutputControl(controls(), '3', outputs);
  assert.deepEqual(next.outputNodeIds, ['2']);
  assert.equal(countControlChanges(next), 1);

  const unchanged = toggleOutputControl(next, '2', outputs);
  assert.deepEqual(unchanged.outputNodeIds, ['2']);

  next = toggleOutputControl(next, '3', outputs);
  assert.equal(next.outputNodeIds, null);
});
