import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIImageProvider } from '../src/agent/llm/openai-image.mjs';

function provider() {
  return new OpenAIImageProvider({
    baseUrl: 'https://images.example.test',
    model: 'image-model',
    apiKey: 'test-key',
  });
}

test('OpenAI image provider sends generations and decodes base64 output', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 });
  };
  try {
    const result = await provider().generate({ prompt: 'a red cabin' });
    assert.equal(request.url, 'https://images.example.test/v1/images/generations');
    assert.equal(JSON.parse(request.options.body).model, 'image-model');
    assert.deepEqual(result.images, [{ base64: 'aW1hZ2U=', mimeType: 'image/png' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI image provider uses edits for references and preserves caller cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    controller.abort('cancelled');
    await new Promise(resolve => setTimeout(resolve, 0));
    throw new DOMException('aborted', 'AbortError');
  };
  try {
    await assert.rejects(
      provider().generate({
        prompt: 'edit this image',
        images: [{ base64: 'aW1hZ2U=', mimeType: 'image/png', filename: 'ref.png' }],
        signal: controller.signal,
      }),
      error => error.code === 'IMAGE_REQUEST_CANCELLED',
    );
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI image provider classifies rate limits as retryable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  try {
    await assert.rejects(
      provider().generate({ prompt: 'a landscape' }),
      error => error.code === 'IMAGE_API_RATE_LIMITED' && error.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
