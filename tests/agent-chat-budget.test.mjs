import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

test('Agent chat applies local preference, 1024 output budget, and context window', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let request;
  agent.llm = {
    isConfigured: true,
    getContextWindow: () => 128,
    async chat(input) {
      request = input;
      return { content: '好的' };
    },
  };

  await agent.chat('你好');

  assert.equal(request.prefer, undefined);
  assert.equal(request.maxTokens, 1024);
  assert.ok(request.messages.length >= 1);
  assert.ok(request.messages[0].role === 'system');
});
