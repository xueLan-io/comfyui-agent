import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeMediaReference } from '../src/runtime/media/media-contract.mjs';
import { inspectMediaFile, hashFile, compareMediaFiles } from '../src/runtime/media/media-metadata.mjs';
import { MediaDownloadService } from '../src/runtime/media/media-download-service.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

test('media reference and image metadata preserve asset fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-contract-')); const file = join(dir, 'x.png'); writeFileSync(file, png);
  const reference = normalizeMediaReference({ path: file, filename: 'x.png', source: { kind: 'local_file' } });
  const info = await inspectMediaFile(file);
  assert.equal(reference.mediaType, 'image'); assert.equal(info.valid, true); assert.equal(info.width, 1); assert.match(await hashFile(file), /^sha256:/);
  assert.equal((await compareMediaFiles(file, file)).sameContent, true);
});

test('media download only accepts owned asset ids and allowed output roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-download-')); const source = join(dir, 'source.png'); const out = join(dir, 'out'); writeFileSync(source, png);
  const service = new MediaDownloadService({ allowedRoots: [out], assetResolver: async (id, owner) => ({ assetId: id, path: source, owner }) });
  const result = await service.download({ assetId: 'asset_1', owner: { projectId: 'p' }, outputPath: join(out, 'result.png') });
  assert.equal(result.assetId, 'asset_1');
  await assert.rejects(() => service.download({ assetId: 'asset_1', owner: { projectId: 'p' }, outputPath: source }), /outside/);
});
