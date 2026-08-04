import { existsSync } from 'node:fs';
import { extname } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_CHAT_IMAGES = 4;

function isImagePath(value) {
  return typeof value === 'string' && IMAGE_EXTENSIONS.has(extname(value).toLowerCase()) && existsSync(value);
}

function addImage(images, value) {
  const path = typeof value === 'string' ? value : value?.path;
  if (!isImagePath(path) || images.some(item => item.path === path)) return;
  images.push({ ...(typeof value === 'object' ? value : {}), path, name: value?.name || path.split(/[\\/]/).pop() });
}

export function collectChatImages(text, media = {}) {
  const images = [];
  for (const image of media.images || []) addImage(images, image);

  const pathPattern = /(?:"([A-Za-z]:\\[^"\r\n]+|\/[^"\r\n]+)"|'([A-Za-z]:\\[^'\r\n]+|\/[^'\r\n]+)'|((?:[A-Za-z]:\\|\/)[^\s"']+))/g;
  for (const match of String(text || '').matchAll(pathPattern)) {
    addImage(images, match[1] || match[2] || match[3]);
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
