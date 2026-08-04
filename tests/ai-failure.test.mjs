import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

test('AI generation failure returns stable choices without invoking direct generation', async () => {
  const agent = new Agent({
    llmConfig: { provider: 'openai-compatible', baseUrl: '', model: '', apiKey: '' },
  });
  let planned = false;
  agent.planner.createPlan = async () => {
    planned = true;
    throw new Error('planner should not run');
  };

  const result = await agent.prepareGeneration('AI generate a cat', { intent: 'generate' });

  assert.deepEqual(result, {
    action: 'ai_failed',
    error: 'AI generation requires a configured language model',
    originalRequest: 'AI generate a cat',
    choices: ['retry_ai', 'direct_original'],
  });
  assert.equal(planned, false);
  assert.equal(agent.state, 'failed');
});

test('planner-level AI errors use the same failure contract', async () => {
  const agent = new Agent({
    llmConfig: { provider: 'openai-compatible', baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'test-key' },
  });
  agent.llm = { isConfigured: true };
  agent.planner.createPlan = async () => {
    throw new Error('LLM unavailable');
  };

  const result = await agent.prepareGeneration('a cat', {
    workflowManifest: { workflowName: 'test.json', modelType: 'generic', promptProfile: {} },
  });

  assert.deepEqual(result, {
    action: 'ai_failed',
    error: 'LLM unavailable',
    originalRequest: 'a cat',
    choices: ['retry_ai', 'direct_original'],
  });
});
