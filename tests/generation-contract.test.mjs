import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGenerationResult } from '../src/runtime/generation-contract.mjs';

test('normalizeGenerationResult exposes unified media without dropping legacy fields', () => {
  const result = normalizeGenerationResult({ images: [{ filename: 'a.png' }], videos: [{ filename: 'b.mp4' }] });
  assert.equal(result.images.length, 1);
  assert.equal(result.videos.length, 1);
  assert.deepEqual(result.media.map(item => item.filename), ['a.png', 'b.mp4']);
});

test('normalizeGenerationResult derives media fields from mixed legacy output', () => {
  const result = normalizeGenerationResult({
    media: [{ filename: 'clip.mp4' }, { filename: 'still.png' }],
  });

  assert.deepEqual(result.images.map(item => item.filename), ['still.png']);
  assert.deepEqual(result.videos.map(item => item.filename), ['clip.mp4']);
});
