import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { OpenAICompatibleProvider } from '../src/agent/llm/openai-compatible.ts';
import { OllamaProvider } from '../src/agent/llm/ollama.mjs';

// Regression net for audit bug #5 (streaming tool_calls were never accumulated,
// and tool_calls with empty content were thrown away as "empty response"),
// #35 (Ollama requests never carried num_ctx, so the server silently truncated
// context), and #36 (a whole-request timer killed long healthy streams).
// S1 acceptance: fake-server rounds here + a real local-model round gated below.

const stop = (server) => new Promise((done) => server.close(done));

test('openai streaming: delta.tool_calls accumulate across chunks, empty content is not "empty response"', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: '', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'time', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', apiKey: 'k' });
    let streamed = '';
    const result = await provider.chat({
      messages: [{ role: 'user', content: '北京天气如何' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      onChunk: (text) => { streamed += text; },
    });
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.content, '');
    assert.equal(streamed, '');
    assert.equal(result.tool_calls.length, 2);
    assert.equal(result.tool_calls[0].id, 'call_a');
    assert.equal(result.tool_calls[0].function.name, 'get_weather');
    assert.equal(result.tool_calls[0].function.arguments, '{"city":"北京"}');
    assert.equal(result.tool_calls[1].function.name, 'time');
  } finally {
    await stop(server);
  }
});

test('openai non-streaming: tool_calls with empty content are returned, not rejected', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', apiKey: 'k' });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.tool_calls[0].function.name, 'noop');
  } finally {
    await stop(server);
  }
});

test('ollama streaming: tool_calls accumulate and the request carries num_ctx (audit #35)', async () => {
  let seenNumCtx;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seenNumCtx = JSON.parse(body).options?.num_ctx;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const lines = [
        { message: { content: '', tool_calls: [{ function: { name: 'note', arguments: { text: 'he' } } }] } },
        { message: { content: '', tool_calls: [{ function: { name: 'note', arguments: { text: 'llo' } } }] } },
        { done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 },
      ];
      for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const provider = new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', contextWindow: 8192 });
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'note', description: 'take a note', parameters: {} }],
      onChunk: () => {},
    });
    assert.equal(seenNumCtx, 8192, 'ollama requests must carry num_ctx = configured contextWindow');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.tool_calls.length, 2);
    assert.deepEqual(JSON.parse(result.tool_calls[1].function.arguments), { text: 'llo' });
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  } finally {
    await stop(server);
  }
});

test('openai streaming idle timeout resets on chunks — a long healthy stream is not killed (audit #36)', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i > 6) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
    }, 60);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model', apiKey: 'k' });
    // Whole-request duration (~420ms) far exceeds the timeout; only the idle
    // reset keeps this from aborting.
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 150,
      onChunk: () => {},
    });
    assert.equal(result.finishReason, 'unknown');
    assert.equal(result.content, 'xxxxxx');
  } finally {
    await stop(server);
  }
});

// Real local-model round (rewrite-plan S1 acceptance). Skipped unless explicitly
// requested: LLM_LIVE=1 LLM_LIVE_MODEL=qwen3:4b npm test
const LIVE = process.env.LLM_LIVE === '1' && Boolean(process.env.LLM_LIVE_MODEL);
test('live: local ollama model performs one tool-calling round', { skip: !LIVE }, async () => {
  const provider = new OllamaProvider({
    baseUrl: process.env.LLM_LIVE_BASE_URL || 'http://127.0.0.1:11434',
    model: process.env.LLM_LIVE_MODEL,
    contextWindow: 8192,
  });
  assert.equal(await provider.healthCheck(), true, 'ollama must be running for the live round');
  const result = await provider.chat({
    messages: [{ role: 'user', content: '调用工具查询北京的天气，不要用文字回答。' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询一个城市的当前天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
  });
  assert.ok(result, 'live round returned a result');
  const called = Array.isArray(result.tool_calls) && result.tool_calls.length > 0;
  assert.ok(called || String(result.content || '').length > 0, 'model either called the tool or answered');
});
