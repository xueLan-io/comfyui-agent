import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRuntimeCapabilities } from '../src/runtime/runtime-capabilities.mjs';

test('runtime capabilities identify NVIDIA and preserve VRAM values', async () => {
  const result = await inspectRuntimeCapabilities({
    client: { async systemStats() { return { devices: [{ name: 'NVIDIA RTX 4090', type: 'cuda', vram_total: 24000, vram_free: 12000 }] }; } },
    ffmpegResolver: async () => 'C:/ffmpeg/bin/ffmpeg.exe',
  });

  assert.equal(result.runtime.comfyui.reachable, true);
  assert.equal(result.runtime.gpu.vendor, 'nvidia');
  assert.equal(result.runtime.gpu.vramTotal, 24000);
  assert.equal(result.runtime.ffmpeg.available, true);
  assert.equal(result.issues.length, 0);
});

test('runtime capabilities identify AMD HIP and report missing FFmpeg as a warning', async () => {
  const result = await inspectRuntimeCapabilities({
    client: { async systemStats() { return { devices: [{ name: 'AMD Radeon RX 7900', type: 'hip', vram_total: 16000, vram_free: 8000 }] }; } },
    ffmpegResolver: async () => null,
  });

  assert.equal(result.runtime.gpu.vendor, 'amd');
  assert.equal(result.runtime.gpu.backend, 'hip');
  assert.equal(result.runtime.ffmpeg.available, false);
  assert.equal(result.issues[0].code, 'ffmpeg_missing');
  assert.equal(result.issues[0].severity, 'warning');
});

test('runtime capabilities can require ComfyUI and FFmpeg for execution', async () => {
  const result = await inspectRuntimeCapabilities({
    client: { async systemStats() { throw new Error('connection refused'); } },
    requireConnection: true,
    requireFfmpeg: true,
    ffmpegResolver: async () => null,
  });

  assert.equal(result.runtime.comfyui.reachable, false);
  assert.ok(result.issues.some(issue => issue.code === 'comfyui_unreachable' && issue.severity === 'error'));
  assert.ok(result.issues.some(issue => issue.code === 'ffmpeg_missing' && issue.severity === 'error'));
});
