import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

test('suggestSessionTitle derives a local stable title without calling the LLM', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let called = false;
  agent.llm = {
    isConfigured: true,
    async chat() {
      called = true;
      return { content: '「画一只猫。」' };
    },
  };
  const result = await agent.suggestSessionTitle('帮我画一只猫在草地上');
  assert.equal(result.title, '帮我画一只猫在草地上');
  assert.equal(called, false);
});

test('suggestSessionTitle falls back to truncation when no LLM is configured', async () => {
  const agent = new Agent({});
  agent.llm = { isConfigured: false };
  const text = '今天想生成一张赛博朋克风格的图';
  const result = await agent.suggestSessionTitle(text);
  assert.equal(result.title, text.slice(0, 12));
});

test('suggestSessionTitle returns the default title for an empty message', async () => {
  const agent = new Agent({});
  agent.llm = { isConfigured: false };
  const result = await agent.suggestSessionTitle('   ');
  assert.equal(result.title, '新会话');
});
