import { existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { ComfyUITool } from './index.mjs';
import { parseImageInfo } from './image-header.mjs';
import { resolveSandboxFile } from '../../security/sandbox.mjs';

function resolveLocalFile(input, pathValue) {
  return resolveSandboxFile(input, pathValue);
}

function normalizeRef(image = {}) {
  if (typeof image === 'string') return image;
  if (image.path) return { path: image.path };
  return {
    filename: image.filename || '',
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  };
}

async function inspectRef(input, image) {
  const client = ComfyUITool.client;
  if (image.path || typeof image === 'string') {
    let filePath;
    try {
      filePath = resolveLocalFile(input, typeof image === 'string' ? image : image.path);
    } catch (error) {
      return { exists: false, error: error.message };
    }
    if (!existsSync(filePath)) return { exists: false, error: `File not found: ${filePath}` };
    const stat = statSync(filePath);
    const bytes = new Uint8Array(await readFile(filePath));
    const info = parseImageInfo(bytes) || {};
    const result = {
      exists: true,
      filename: filePath.split(/[\\/]/).pop(),
      path: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      format: info.format || 'unknown',
      width: info.width ?? null,
      height: info.height ?? null,
      hasAlpha: Boolean(info.hasAlpha),
      metadata: info.metadata || null,
    };
    if (input.withDataUrl && typeof client.imageDataUrl === 'function') {
      result.dataUrl = await client.imageDataUrl({ path: filePath }).catch(() => null);
    }
    return result;
  }

  if (!image.filename) return { exists: false, error: 'filename is required' };
  const existing = await client.inspectImage(image).catch(() => null);
  const bytes = existing?.exists
    ? await client.fetchImageBytes?.(image).catch(() => null)
    : null;
  if (!bytes || bytes.length === 0) {
    return { filename: image.filename, exists: false, readable: false, validFormat: false };
  }
  const info = parseImageInfo(bytes) || {};
  const result = {
    exists: true,
    readable: true,
    validFormat: Boolean(info.format && info.format !== 'unknown'),
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
    sizeBytes: bytes.length,
    format: info.format || 'unknown',
    width: info.width ?? null,
    height: info.height ?? null,
    hasAlpha: Boolean(info.hasAlpha),
    metadata: info.metadata || null,
  };
  if (input.withDataUrl) {
    result.dataUrl = await client.imageDataUrl(image).catch(() => null);
  }
  return result;
}

export const InspectImageTool = {
  name: 'inspect_image',
  description: 'Inspect a local image: format, dimensions, alpha channel, file size, and embedded generation metadata (PNG). Optionally return a base64 data URL. Read-only.',
  category: 'management',
  tags: ['image', 'inspect', 'metadata', 'preview'],
  timeout_ms: 15000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      image: { type: 'object' },
      images: { type: 'array', items: { type: 'object' } },
      sameDimensions: { type: 'boolean' },
      sameFormat: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['inspect', 'compare'], description: 'Action to perform' },
      image: { type: 'object', description: 'Local path string, or {filename, subfolder, type}, or {path}' },
      other: { type: 'object', description: 'Second image for compare' },
      withDataUrl: { type: 'boolean', description: 'Include a base64 data URL in the result' },
      workflowDir: { type: 'string', description: 'Trusted workflow directory supplied by the runtime' },
      comfyRoot: { type: 'string', description: 'Trusted ComfyUI root supplied by the runtime' },
    },
    required: ['action', 'image'],
  },

  async execute(input) {
    const { action, image, other } = input;
    if (action === 'compare') {
      const [a, b] = await Promise.all([inspectRef(input, normalizeRef(image)), inspectRef(input, normalizeRef(other))]);
      return {
        images: [a, b],
        sameDimensions: a.exists && b.exists && a.width === b.width && a.height === b.height,
        sameFormat: a.exists && b.exists && a.format === b.format,
      };
    }
    return { image: await inspectRef(input, normalizeRef(image)) };
  },
};
