import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachVisionImages, collectChatImages } from '../src/agent/runtime/chat-vision.mjs';
import { sanitizeMessages } from '../src/agent/schemas/context-sanitizer.mjs';

test('collectChatImages accepts selected media and an authorized pasted local path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfy-agent-vision-'));
  const imagePath = join(dir, 'reference.png');
  writeFileSync(imagePath, 'image');
  try {
    // With an authorizer (the sandbox check wired by the Agent) pasted paths
    // inside the approved root are attached.
    const images = collectChatImages(`描述图片 "${imagePath}"`, { images: [] }, { authorizePath: path => path === imagePath });
    assert.equal(images.length, 1);
    assert.equal(images[0].path, imagePath);
    // Without an authorizer the text scan is skipped entirely (fail-closed):
    // arbitrary disk files are never read implicitly.
    const noAuthorizer = collectChatImages(`描述图片 "${imagePath}"`, { images: [] });
    assert.equal(noAuthorizer.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachVisionImages keeps image content structured for vision APIs', async () => {
  const messages = await attachVisionImages(
    [{ role: 'user', content: '描述图片' }],
    [{ path: 'reference.png' }],
    async () => 'data:image/png;base64,abc',
  );
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '描述图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
  ]);
  const sanitized = sanitizeMessages(messages);
  assert.equal(Array.isArray(sanitized[0].content), true);
  assert.equal(sanitized[0].content[1].image_url.url, 'data:image/png;base64,abc');
});
