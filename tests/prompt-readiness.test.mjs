import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPromptReadiness } from '../src/agent/tools/prompt/readiness.mjs';

test('execute reuses the previous prompt when one exists', () => {
  const result = assessPromptReadiness({
    request: '\u6267\u884c',
    intent: 'generate',
    lastPrompt: 'a blue cat on a windowsill',
  });
  assert.equal(result.readiness, 'ready');
  assert.deepEqual(result.missing, []);
});

test('execute without a previous prompt asks for a subject', () => {
  const result = assessPromptReadiness({
    request: '\u6267\u884c',
    intent: 'generate',
  });
  assert.equal(result.readiness, 'clarify');
  assert.deepEqual(result.missing, ['subject']);
});
