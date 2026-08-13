import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_CHAT_IMAGES = 4;
// Files above this size are never auto-attached (avoids shipping huge payloads
// to the configured LLM provider without the user's awareness).
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function isImagePath(value) {
  return typeof value === 'string' && IMAGE_EXTENSIONS.has(extname(value).toLowerCase()) && existsSync(value);
}

function addImage(images, value, maxBytes = DEFAULT_MAX_BYTES) {
  const path = typeof value === 'string' ? value : value?.path;
  if (!isImagePath(path) || images.some(item => item.path === path)) return;
  if (maxBytes > 0) {
    try {
      if (statSync(path).size > maxBytes) return;
    } catch {
      return;
    }
  }
  images.push({ ...(typeof value === 'object' ? value : {}), path, name: value?.name || path.split(/[\\/]/).pop() });
}

// Collects vision images for a chat message:
// - `media.images` are explicit user attachments (kept as-is, size-capped).
// - Path-like text is only followed when `authorizePath` approves the path
//   against the runtime sandbox; without an authorizer the text scan is
//   skipped entirely (fail-closed), so arbitrary disk files are never read
//   and forwarded to the LLM provider implicitly.
export function collectChatImages(text, media = {}, options = {}) {
  const images = [];
  const { authorizePath = null, maxBytes = DEFAULT_MAX_BYTES } = options || {};
  for (const image of media.images || []) addImage(images, image, maxBytes);

  const pathPattern = /(?:"([A-Za-z]:\\[^"\r\n]+|\/[^"\r\n]+)"|'([A-Za-z]:\\[^'\r\n]+|\/[^'\r\n]+)'|((?:[A-Za-z]:\\|\/)[^\s"']+))/g;
  for (const match of String(text || '').matchAll(pathPattern)) {
    const candidate = match[1] || match[2] || match[3];
    if (!authorizePath || !authorizePath(candidate)) continue;
    addImage(images, candidate, maxBytes);
    if (images.length >= MAX_CHAT_IMAGES) break;
  }
  return images.slice(0, MAX_CHAT_IMAGES);
}

export async function attachVisionImages(messages, images, imageDataUrl) {
  if (!images.length || typeof imageDataUrl !== 'function') return messages;

  const parts = [];
  for (const image of images) {
    const url = await imageDataUrl(image).catch(() => null);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  if (parts.length === 0) return messages;

  const result = messages.map(message => ({ ...message }));
  const index = result.findLastIndex(message => message.role === 'user');
  if (index < 0) return messages;
  const message = result[index];
  const content = Array.isArray(message.content)
    ? [...message.content]
    : [{ type: 'text', text: String(message.content || '') }];
  result[index] = { ...message, content: [...content, ...parts] };
  return result;
}
