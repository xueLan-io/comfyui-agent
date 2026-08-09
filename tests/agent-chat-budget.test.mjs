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

test('Agent chat separates response language from local workflow prompt language', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let request;
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'local', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat(input) {
      request = input;
      return { content: 'ok' };
    },
  };

  await agent.chat('帮我写一个提示词', {
    intent: 'prompt_edit',
    workflowManifest: {
      workflowName: 'local.json',
      promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true },
    },
  });

  const system = String(request.messages[0].content);
  assert.match(system, /解释、建议和问题使用用户的语言/);
  assert.match(system, /正向和负向提示词使用英文且不混用中文/);
});
