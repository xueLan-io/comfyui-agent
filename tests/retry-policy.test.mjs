import assert from 'node:assert/strict';
import test from 'node:test';
import { RetryPolicy } from '../src/agent/optimizer/retry-policy.mjs';

test('accept good result', () => {
  const policy = new RetryPolicy();
  const decision = policy.evaluate({ scores: { overall: 0.8, technical: 1, alignment: 1, creative: 1 } });
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.action, 'accept');
});

test('retry on low technical score', () => {
  const policy = new RetryPolicy();
  const decision = policy.evaluate({ scores: { overall: 0.3, technical: 0.2, alignment: 1, creative: 1 } });
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.action, 'retry');
  assert.equal(decision.attempt, 1);
});

test('change_seed on low creative', () => {
  const policy = new RetryPolicy();
  const decision = policy.evaluate({ scores: { overall: 0.4, technical: 1, alignment: 1, creative: 0.3 } });
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.action, 'change_seed');
});

test('rewrite on misalignment', () => {
  const policy = new RetryPolicy();
  const decision = policy.evaluate({ scores: { overall: 0.5, technical: 1, alignment: 0.3, creative: 1 } });
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.action, 'rewrite_prompt');
});

test('max attempts reached', () => {
  const policy = new RetryPolicy();
  for (let i = 0; i < 3; i++) {
    policy.evaluate({ scores: { overall: 0.3, technical: 0.2, alignment: 1, creative: 1 } });
  }
  const decision = policy.evaluate({ scores: { overall: 0.3, technical: 0.2, alignment: 1, creative: 1 } });
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.action, 'accept');
});

test('reset clears attempt counter', () => {
  const policy = new RetryPolicy();
  policy.evaluate({ scores: { overall: 0.3, technical: 0.2, alignment: 1, creative: 1 } });
  policy.reset();
  const decision = policy.evaluate({ scores: { overall: 0.3, technical: 0.2, alignment: 1, creative: 1 } });
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.attempt, 1);
});

test('nil evalResult returns accept', () => {
  const policy = new RetryPolicy();
  const decision = policy.evaluate(null);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.action, 'accept');
});
