import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchQuery } from '../src/agent/runtime/research-ops.mjs';

// 构造一个可注入返回内容的假 LLM，并记录收到的 system prompt
function agentWithLLM(content) {
  const agent = {
    llm: {
      isConfigured: true,
      strategy: 'local',
      async chat({ messages }) {
        agent.lastSystemPrompt = messages.find(message => message.role === 'system')?.content || '';
        return { content };
      },
    },
  };
  return agent;
}

test('buildSearchQuery keeps quoted work titles and entities after 中的/角色 even when the LLM drops them', async () => {
  const agent = agentWithLLM('角色 外貌'); // LLM 把《原神》和沃雅妮莎都丢了
  const query = await buildSearchQuery(agent, '帮我查一下《原神》中的角色沃雅妮莎的外貌');
  assert.match(query, /《原神》/);
  assert.match(query, /沃雅妮莎/);
  // 提示词本身必须要求保留作品名与专有名词
  assert.match(agent.lastSystemPrompt, /《原神》/);
  assert.match(agent.lastSystemPrompt, /专有名词/);
});

test('buildSearchQuery leaves anchors already present in the LLM output untouched', async () => {
  const agent = agentWithLLM('《原神》 沃雅妮莎 外观');
  const query = await buildSearchQuery(agent, '使用搜索查一下《原神》中的角色沃雅妮莎的外貌');
  assert.equal(query, '《原神》 沃雅妮莎 外观');
});

test('buildSearchQuery restores 书名号 around a bare work title returned by the LLM', async () => {
  const agent = agentWithLLM('原神 沃雅妮莎'); // LLM 保留了词但去掉了书名号
  const query = await buildSearchQuery(agent, '查《原神》中的角色沃雅妮莎');
  assert.equal(query, '《原神》 沃雅妮莎');
});

test('buildSearchQuery preserves the entity after 人物', async () => {
  const agent = agentWithLLM('资料');
  const query = await buildSearchQuery(agent, '查一下人物沃雅妮莎的资料');
  assert.match(query, /沃雅妮莎/);
});

test('buildSearchQuery preserves an entity placed directly after a work title', async () => {
  const agent = agentWithLLM('介绍');
  const query = await buildSearchQuery(agent, '使用搜索《原神》 沃雅妮莎 介绍');
  assert.equal(query, '《原神》 沃雅妮莎 介绍');
});

test('buildSearchQuery strips 使用搜索 and other spoken prefixes without an LLM', async () => {
  const agent = { llm: { isConfigured: false } };
  const query = await buildSearchQuery(agent, '使用搜索查一下《原神》中的沃雅妮莎');
  assert.equal(query, '《原神》中的沃雅妮莎');
});

test('buildSearchQuery falls back to prefix stripping when the LLM call fails', async () => {
  const agent = {
    llm: {
      isConfigured: true,
      strategy: 'local',
      async chat() { throw new Error('LLM unavailable'); },
    },
  };
  const query = await buildSearchQuery(agent, '使用搜索帮我查一下《原神》中的角色沃雅妮莎');
  assert.equal(query, '《原神》中的角色沃雅妮莎');
});

test('buildSearchQuery returns empty string for blank input', async () => {
  assert.equal(await buildSearchQuery({ llm: { isConfigured: false } }, '   '), '');
});
