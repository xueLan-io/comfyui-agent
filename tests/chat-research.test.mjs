import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, wantsWebResearch, chatResearchContext } from '../src/agent/runtime/agent.mjs';

test('wantsWebResearch detects search requests but not local queries', () => {
  assert.equal(wantsWebResearch('搜索一下《原神》中的奥黛塔', 'chat'), true);
  assert.equal(wantsWebResearch('帮我查查这个角色的人物资料', 'chat'), true);
  assert.equal(wantsWebResearch('看看 https://baike.baidu.com/item/x 是什么', 'chat'), true);
  assert.equal(wantsWebResearch('https://baike.baidu.com/item/x', undefined), true);
  assert.equal(wantsWebResearch('当前工作流有哪些节点', 'workflow_query'), false);
  assert.equal(wantsWebResearch('当前参数是什么', 'chat'), false);
  assert.equal(wantsWebResearch('帮我把提示词改得更华丽', 'prompt_edit'), false);
  assert.equal(wantsWebResearch('你好', 'chat'), false);
});

test('chatResearchContext renders sources and honest failure', () => {
  const text = chatResearchContext({
    query: '奥黛塔',
    sources: [{ title: 'Odette', url: 'https://example.com/odette', snippet: '首席芭蕾舞者', content: '冰蓝长发 紫色眼睛' }],
  });
  assert.match(text, /\[来源1\] Odette/);
  assert.match(text, /https:\/\/example.com\/odette/);

  const failed = chatResearchContext({ query: 'x', sources: [], message: 'All search providers failed' });
  assert.match(failed, /未返回可用资料/);
  assert.match(failed, /All search providers failed/);
});

test('_chatResearch collects sources from opened URL and search results', async () => {
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-chat',
    _traceId: 'trace-chat',
    tools: {
      web: {
        async execute(input) {
          if (input.action === 'open') {
            if (String(input.url).includes('baike')) {
              return { page: { url: input.url, title: '奥黛塔 百度百科', description: '介绍', content: '冰蓝长发、紫色眼睛的芭蕾舞者' } };
            }
            return { page: { url: input.url, title: 'Result', description: '', content: '原神角色资料' } };
          }
          return { results: [
            { title: 'Wiki', url: 'https://wiki.example/odette', snippet: '首席芭蕾舞者', trustLevel: 'community' },
          ] };
        },
      },
    },
  });

  const result = await agent._chatResearch('看看 https://baike.baidu.com/item/x 的资料', { maxOpenPages: 2, maxResults: 5, timeoutMs: 1000, allowNetwork: true, cacheTtlMs: 0, proxyUrl: '', sourcePolicy: {} });
  assert.equal(result.status, 'complete');
  const urls = result.sources.map(source => source.url);
  assert.ok(urls.includes('https://baike.baidu.com/item/x'));
  assert.ok(urls.includes('https://wiki.example/odette'));
});

test('_chatResearch reports no sources when everything fails', async () => {
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-chat',
    _traceId: 'trace-chat',
    tools: { web: { async execute() { return { error: 'connection refused' }; } } },
  });

  const result = await agent._chatResearch('搜索奥黛塔', { maxOpenPages: 2, maxResults: 5, timeoutMs: 1000, allowNetwork: true, cacheTtlMs: 0, proxyUrl: '', sourcePolicy: {} });
  assert.equal(result.status, 'no_sources');
  assert.deepEqual(result.sources, []);
  assert.match(result.message, /connection refused/);
});

test('chat performs web research without a configured language model', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', baseUrl: '', model: '', apiKey: '' } });
  agent._chatResearch = async () => ({ sources: [{ title: 'Hero', url: 'https://example.com/hero', snippet: 'Blue eyes' }] });
  const result = await agent.chat('search Hero appearance');
  assert.match(result.response, /Hero/);
  assert.match(result.response, /https:\/\/example\.com\/hero/);
});
