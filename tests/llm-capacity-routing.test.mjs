import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/agent/llm/openai-compatible.mjs';
import { LLMProvider, fitMessagesToContext } from '../src/agent/llm/provider.mjs';

const LOCAL = { id: 'local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model' }] };
const CLOUD = { id: 'cloud', type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'key', models: [{ id: 'cloud-model' }] };

function response(content) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
}

test('local OpenAI-compatible requests disable thinking and reasoning effort', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return response('ok');
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: LOCAL.baseUrl,
      model: 'local-model',
      reasoningEffort: 'high',
      local: true,
    });
    await provider.chat({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(body.thinking, false);
    assert.equal('reasoning_effort' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto local health probe is cached for ten seconds', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method || 'POST' });
    return options.method === 'GET' ? response('models') : response('local');
  };
  try {
    const provider = new LLMProvider({ providers: [LOCAL, CLOUD], active: { providerId: 'local', modelId: 'local-model', strategy: 'auto' } });
    await provider.chat({ messages: [{ role: 'user', content: 'one' }] });
    await provider.chat({ messages: [{ role: 'user', content: 'two' }] });
    assert.equal(requests.filter(request => request.method === 'GET').length, 1);
    assert.equal(requests.filter(request => request.method === 'POST').length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed auto local probe errors without touching the cloud', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method || 'POST' });
    if (options.method === 'GET') throw new Error('local offline');
    return response('cloud');
  };
  try {
    const provider = new LLMProvider({ providers: [LOCAL, CLOUD], active: { providerId: 'local', modelId: 'local-model', strategy: 'auto' } });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'safe request' }] }),
      /选中的本地模型不可用/,
    );
    assert.deepEqual(requests.map(request => request.method), ['GET']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prefer cloud falls back to local after cloud failure when no provider is pinned', async () => {
  const originalFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') throw new Error('probe should not run for cloud preference');
    const model = JSON.parse(options.body).model;
    models.push(model);
    if (model === 'cloud-model') throw new Error('cloud down');
    return response('local fallback');
  };
  try {
    const provider = new LLMProvider({ providers: [LOCAL, CLOUD], active: { providerId: '', modelId: '', strategy: 'auto' } });
    const result = await provider.chat({ prefer: 'cloud', messages: [{ role: 'user', content: 'safe request' }] });
    assert.equal(result.content, 'local fallback');
    assert.deepEqual(models, ['cloud-model', 'local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fitMessagesToContext keeps system and newest messages within budget', () => {
  const messages = [
    { role: 'system', content: 'System rules must remain.' },
    { role: 'user', content: 'old context '.repeat(20) },
    { role: 'assistant', content: 'old answer '.repeat(20) },
    { role: 'user', content: 'latest request' },
  ];
  const fitted = fitMessagesToContext(messages, 12);
  assert.equal(fitted[0].role, 'system');
  assert.equal(fitted.at(-1).content, 'latest request');
  assert.ok(fitted.length < messages.length);
  assert.ok(fitted.reduce((total, message) => total + String(message.content || '').length, 0) < 200);
});

test('model contextWindow overrides the default provider window', () => {
  const provider = new LLMProvider({
    providers: [{ ...LOCAL, models: [{ id: 'local-model', contextWindow: 4096 }] }],
    active: { providerId: 'local', modelId: 'local-model', strategy: 'local' },
  });
  assert.equal(provider.getContextWindow('local'), 4096);
  assert.equal(provider.contextWindow, 4096);
});

test('local provider serializes overlapping requests', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response('models');
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return response('ok');
  };
  try {
    const provider = new LLMProvider({ providers: [LOCAL], active: { providerId: 'local', modelId: 'local-model', strategy: 'local' } });
    await Promise.all([
      provider.chat({ messages: [{ role: 'user', content: 'one' }] }),
      provider.chat({ messages: [{ role: 'user', content: 'two' }] }),
    ]);
    assert.equal(maximum, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
