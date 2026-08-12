import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/agent/llm/openai-compatible.mjs';
import { LLMProvider } from '../src/agent/llm/provider.mjs';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { extractRequestedSettings } from '../src/agent/runtime/planner.mjs';

test('adds the standard v1 path to a bare compatible API origin', () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.com',
    model: 'test-model',
    apiKey: 'test-key',
  });
  assert.equal(provider.baseUrl, 'https://example.com/v1');
});

test('selects a provider and model from the provider table', () => {
  const provider = new LLMProvider({
    providers: [{ id: 'one', type: 'openai-compatible', baseUrl: 'https://one.example/v1', apiKey: 'key', models: [{ id: 'model-a' }, { id: 'model-b' }] }],
    active: { providerId: 'one', modelId: 'model-b', reasoningEffort: 'high' },
  });
  assert.equal(provider.config.providerId, 'one');
  assert.equal(provider.config.model, 'model-b');
  assert.equal(provider.config.reasoningEffort, 'high');
});

test('merges custom headers and sends reasoning effort', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'reasoner',
      apiKey: 'key',
      headers: { 'X-Tenant': 'studio' },
      reasoningEffort: 'high',
    });
    await provider.chat({ messages: [{ role: 'user', content: 'test' }] });
    assert.equal(request.headers['X-Tenant'], 'studio');
    assert.equal(JSON.parse(request.body).reasoning_effort, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streams compatible model deltas in order', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return new Response(chunks.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    const deltas = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'test' }],
      onChunk: delta => deltas.push(delta),
    });
    assert.equal(JSON.parse(request.body).stream, true);
    assert.deepEqual(deltas, ['你好', '，世界']);
    assert.equal(result.content, '你好，世界');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards reasoning deltas to onReasoningStart/onReasoningText without mixing them into content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想想' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '再回答' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '答案' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return new Response(chunks.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    const reasoning = [];
    let reasoningStarts = 0;
    const deltas = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'test' }],
      onReasoningStart: () => reasoningStarts += 1,
      onReasoningText: text => reasoning.push(text),
      onChunk: delta => deltas.push(delta),
    });
    assert.equal(reasoningStarts, 1);
    assert.deepEqual(reasoning, ['先想想', '再回答']);
    assert.deepEqual(deltas, ['答案']);
    assert.equal(result.content, '答案');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recognizes the OpenAI-style reasoning field name as thinking deltas', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: '思考中' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return new Response(chunks.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    const reasoning = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'test' }],
      onReasoningText: text => reasoning.push(text),
      onChunk: () => {},
    });
    assert.deepEqual(reasoning, ['思考中']);
    assert.equal(result.content, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('delivers the first SSE delta before the compatible request resolves', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`)), 15);
        setTimeout(() => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ' second' } }] })}\n\ndata: [DONE]\n\n`)), 45);
        setTimeout(() => controller.close(), 50);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    let resolved = false;
    let firstDeltaAt = 0;
    const startedAt = Date.now();
    const request = provider.chat({
      messages: [{ role: 'user', content: 'test' }],
      onChunk(delta) {
        if (delta === 'first') firstDeltaAt = Date.now();
      },
    }).then(result => {
      resolved = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(firstDeltaAt >= startedAt);
    assert.equal(resolved, false);
    assert.equal((await request).content, 'first second');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a completed compatible stream with no text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'test' }], onChunk() {} }),
      error => error.code === 'EMPTY_MODEL_RESPONSE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inflates max_tokens for reasoning models so thinking cannot starve the answer', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'reasoner',
      apiKey: 'key',
      reasoningEffort: 'high',
    });
    await provider.chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 1024 });
    assert.ok(bodies[0].max_tokens > 1024, `expected inflated max_tokens, got ${bodies[0].max_tokens}`);
    assert.equal(bodies[0].reasoning_effort, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not inflate max_tokens for non-reasoning models', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'plain',
      apiKey: 'key',
      reasoningEffort: '',
    });
    await provider.chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 1024 });
    assert.equal(bodies[0].max_tokens, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tags a length-limited empty stream as budget exhausted', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考很多' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'reasoner',
      apiKey: 'key',
      reasoningEffort: 'high',
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'test' }], onChunk() {}, onReasoningText() {} }),
      error => error.code === 'EMPTY_MODEL_RESPONSE' && error.budgetExhausted === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a compatible stream that ends before its done marker', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'stream-model',
      apiKey: 'key',
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'test' }], onChunk() {} }),
      error => error.code === 'LLM_STREAM_INTERRUPTED',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a corrupted saved API key before fetch with an actionable error', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('fetch should not be called');
  };
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.com/v1',
      model: 'test-model',
      apiKey: 'v10\ufffdcorrupted',
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'test' }] }),
      /Saved API key could not be decrypted\. Re-enter it in Settings\./,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat mode does not create an image generation plan without an LLM', async () => {
  const agent = new Agent({
    llmConfig: { provider: 'openai-compatible', baseUrl: '', model: '', apiKey: '' },
  });
  const result = await agent.chat('hi');
  assert.ok(result.response);
  assert.equal(agent.isRunning, false);
  assert.match(result.taskId, /^chat_/);
});

test('ordinary chat does not receive workflow and runtime context', async () => {
  const agent = new Agent({
    llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' },
  });
  let request;
  agent.llm = {
    isConfigured: true,
    async chat(input) {
      request = input;
      return { content: '好的' };
    },
  };

  await agent.chat('你好');

  const system = request.messages[0].content;
  assert.match(system, /默认自然回答/);
  assert.doesNotMatch(system, /Selected workflow|Current sampling settings|ComfyUI runtime/);
});

test('clamps local model output tokens to the local budget regardless of the caller', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/models')) return new Response('{}', { status: 200 });
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: [{ id: 'lmstudio', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', models: [{ id: 'local-model' }] }],
      active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'auto' },
    });
    await provider.chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 8192 });
    assert.equal(bodies[0].max_tokens, 2048);
    await provider.chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 300 });
    assert.equal(bodies[1].max_tokens, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extracts explicitly requested ComfyUI controls without an LLM', () => {
  assert.deepEqual(
    extractRequestedSettings('尺寸 768x1024，步数 12，CFG 4.5，seed 99，批量 2，重绘幅度 0.65，采样器 dpmpp_2m，调度器 karras'),
    { seed: 99, steps: 12, cfg: 4.5, batch: 2, denoise: 0.65, sampler: 'dpmpp_2m', scheduler: 'karras', width: 768, height: 1024 },
  );
});
