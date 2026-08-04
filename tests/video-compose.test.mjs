import assert from 'node:assert/strict';
import test from 'node:test';
import { composeVideo, isVideoFilename, resolveFfmpeg } from '../src/agent/video/video-compose.mjs';

test('isVideoFilename recognizes video extensions case-insensitively', () => {
  assert.equal(isVideoFilename('a.mp4'), true);
  assert.equal(isVideoFilename('.MP4'), true);
  assert.equal(isVideoFilename('a.png'), false);
  assert.equal(isVideoFilename('a.txt'), false);
});

test('resolveFfmpeg returns a string or null', async () => {
  const result = await resolveFfmpeg();
  assert.ok(typeof result === 'string' || result === null);
});

test('composeVideo rejects when ffmpeg is unavailable', async () => {
  await assert.rejects(
    () => composeVideo({ frames: [{ path: 'a.png' }], outputPath: 'out.mp4', ffmpegPath: null }),
    /ffmpeg/,
  );
});
