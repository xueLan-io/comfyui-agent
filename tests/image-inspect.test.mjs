import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { InspectImageTool } from '../src/agent/tools/comfyui/image-inspect.mjs';

function pngBytes(width, height, colorType, metadata = {}) {
  const chunks = [];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  chunks.push(header);
  for (const [key, text] of Object.entries(metadata)) {
    const keyword = Buffer.from(key, 'latin1');
    const body = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(text, 'latin1')]);
    chunks.push(body);
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length, 0);
    const type = Buffer.from(index === 0 ? 'IHDR' : 'tEXt', 'latin1');
    const crc = Buffer.alloc(4);
    parts.push(length, type, chunk, crc);
  }
  return Buffer.concat(parts);
}

async function withClient(client, fn) {
  const original = ComfyUITool.client;
  ComfyUITool.setClient(client);
  try {
    return await fn();
  } finally {
    ComfyUITool.setClient(original);
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-img-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('inspect reads format, dimensions, alpha, and embedded PNG metadata', async t => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'photo.png');
  await writeFile(filePath, pngBytes(512, 640, 6, { parameters: 'Steps: 28, CFG: 7' }));

  const result = await InspectImageTool.execute({ action: 'inspect', image: { path: filePath }, workflowDir: dir });
  assert.equal(result.image.exists, true);
  assert.equal(result.image.format, 'png');
  assert.equal(result.image.width, 512);
  assert.equal(result.image.height, 640);
  assert.equal(result.image.hasAlpha, true);
  assert.equal(result.image.metadata.parameters, 'Steps: 28, CFG: 7');
  assert.equal(result.image.path, filePath);
});

test('inspect reports no alpha for an opaque png', async t => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'opaque.png');
  await writeFile(filePath, pngBytes(128, 128, 2));

  const result = await InspectImageTool.execute({ action: 'inspect', image: filePath, workflowDir: dir });
  assert.equal(result.image.format, 'png');
  assert.equal(result.image.hasAlpha, false);
  assert.equal(result.image.width, 128);
});

test('inspect rejects a path outside the allowed roots', async t => {
  const dir = await tempDir(t);
  const outside = join(tmpdir(), 'outside-comfy-img.png');
  await writeFile(outside, pngBytes(64, 64, 2));

  const result = await InspectImageTool.execute({ action: 'inspect', image: { path: outside }, workflowDir: dir });
  assert.equal(result.image.exists, false);
  assert.match(result.image.error, /outside the allowed/i);
});

test('inspect a missing local file reports not found', async t => {
  const dir = await tempDir(t);
  const result = await InspectImageTool.execute({ action: 'inspect', image: { path: join(dir, 'nope.png') }, workflowDir: dir });
  assert.equal(result.image.exists, false);
  assert.match(result.image.error, /not found/);
});

test('inspect resolves a ComfyUI output ref through the client', async t => {
  const bytes = pngBytes(256, 256, 6);
  const client = {
    async inspectImage() {
      return { filename: 'result.png', exists: true, readable: true, validFormat: true };
    },
    async fetchImageBytes() {
      return new Uint8Array(bytes);
    },
    async imageDataUrl() {
      return `data:image/png;base64,${bytes.toString('base64')}`;
    },
  };
  const result = await withClient(client, () => InspectImageTool.execute({
    action: 'inspect', image: { filename: 'result.png', type: 'output' }, workflowDir: '',
  }));
  assert.equal(result.image.exists, true);
  assert.equal(result.image.format, 'png');
  assert.equal(result.image.hasAlpha, true);
  assert.equal(result.image.width, 256);
});

test('inspect a ComfyUI ref that does not exist is reported missing', async t => {
  const client = {
    async inspectImage() {
      return { filename: 'gone.png', exists: false, readable: false, validFormat: false };
    },
    async fetchImageBytes() {
      return null;
    },
  };
  const result = await withClient(client, () => InspectImageTool.execute({
    action: 'inspect', image: { filename: 'gone.png', type: 'output' }, workflowDir: '',
  }));
  assert.equal(result.image.exists, false);
});

test('compare reports dimension and format differences', async t => {
  const dir = await tempDir(t);
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  await writeFile(a, pngBytes(512, 512, 2));
  await writeFile(b, pngBytes(256, 512, 2));

  const result = await InspectImageTool.execute({
    action: 'compare', image: { path: a }, other: { path: b }, workflowDir: dir,
  });
  assert.equal(result.images[0].width, 512);
  assert.equal(result.images[1].width, 256);
  assert.equal(result.sameDimensions, false);
  assert.equal(result.sameFormat, true);
});

test('non-image file reports an unknown format', async t => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'notes.txt');
  await writeFile(filePath, 'hello world');

  const result = await InspectImageTool.execute({ action: 'inspect', image: { path: filePath }, workflowDir: dir });
  assert.equal(result.image.format, 'unknown');
  assert.equal(result.image.width, null);
});
