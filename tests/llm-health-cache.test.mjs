import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMProvider } from '../src/agent/llm/provider.mjs';

test('failed local health probe is cached and never falls back to cloud', async () => {
  const originalFetch = globalThis.fetch;
  let probes = 0;
  let cloudCalls = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') {
      probes++;
      throw new Error('local offline');
    }
    cloudCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'cloud' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: [
        { id: 'local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model' }] },
        { id: 'cloud', type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'key', models: [{ id: 'cloud-model' }] },
      ],
      active: { providerId: 'local', modelId: 'local-model', strategy: 'auto' },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'one' }] }), /选中的本地模型不可用/);
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'two' }] }), /选中的本地模型不可用/);
    assert.equal(probes, 1);
    assert.equal(cloudCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
