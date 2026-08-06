import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProgressEvent } from '../src/runtime/progress.mjs';

test('normalizes ComfyUI value and max into a bounded percentage', () => {
  const progress = normalizeProgressEvent({ value: 4, max: 20, node: '7' });
  assert.equal(progress.percent, 20);
  assert.equal(progress.current, 4);
  assert.equal(progress.total, 20);
  assert.equal(progress.indeterminate, false);
  assert.equal(progress.node, '7');
});

test('normalizes fractional progress values without treating percentages as fractions', () => {
  assert.equal(normalizeProgressEvent({ progress: 0.5 }).percent, 50);
  assert.equal(normalizeProgressEvent({ percent: 50 }).percent, 50);
});

test('retains the last known percentage when an event has no numeric progress', () => {
  const progress = normalizeProgressEvent({ stage: 'node', nodeType: 'KSampler' }, { percent: 42 });
  assert.equal(progress.percent, 42);
  assert.equal(progress.indeterminate, false);
  assert.equal(progress.message, '正在执行 KSampler');
});

test('marks progress indeterminate when no percentage has ever been reported', () => {
  const progress = normalizeProgressEvent({ stage: 'executing', message: '工作流开始执行' });
  assert.equal(progress.percent, null);
  assert.equal(progress.indeterminate, true);
});

test('clamps invalid and out-of-range percentages', () => {
  assert.equal(normalizeProgressEvent({ percent: -20 }).percent, 0);
  assert.equal(normalizeProgressEvent({ percent: 140 }).percent, 100);
  assert.equal(normalizeProgressEvent({ value: 4, max: 0 }).percent, null);
});
