import { resolveFfmpeg } from '../agent/video/video-compose.mjs';

function classifyGpu(device = {}) {
  const label = `${device.name || ''} ${device.type || ''}`;
  const vendor = /amd|radeon|hip/i.test(label) ? 'amd' : /nvidia|cuda|geforce|rtx|gtx/i.test(label) ? 'nvidia' : 'unknown';
  return {
    vendor,
    name: device.name || device.type || '',
    backend: device.type || '',
    vramTotal: Number(device.vram_total || 0),
    vramFree: Number(device.vram_free || 0),
  };
}

export async function inspectRuntimeCapabilities({ client, requireConnection = false, requireFfmpeg = false, ffmpegResolver = resolveFfmpeg } = {}) {
  const runtime = {
    comfyui: { reachable: false, error: '' },
    gpu: { vendor: 'unknown', name: '', backend: '', vramTotal: 0, vramFree: 0 },
    ffmpeg: { available: false, path: '' },
  };
  const issues = [];

  if (!client) {
    runtime.comfyui.error = 'ComfyUI client is unavailable';
    issues.push({ code: 'comfyui_unreachable', severity: requireConnection ? 'error' : 'warning', message: runtime.comfyui.error });
  } else if (typeof client.systemStats !== 'function') {
    runtime.comfyui.error = 'ComfyUI system statistics are unavailable';
    issues.push({ code: 'runtime_probe_unavailable', severity: 'warning', message: runtime.comfyui.error });
  } else {
    try {
      const stats = await client.systemStats();
      runtime.comfyui.reachable = true;
      const device = stats?.devices?.find(item => item?.name || item?.type);
      if (device) runtime.gpu = classifyGpu(device);
      else issues.push({ code: 'gpu_unavailable', severity: 'warning', message: 'ComfyUI did not report a usable GPU device' });
    } catch (error) {
      runtime.comfyui.error = error.message;
      issues.push({ code: 'comfyui_unreachable', severity: requireConnection ? 'error' : 'warning', message: `ComfyUI is not reachable: ${error.message}` });
    }
  }

  try {
    const path = await ffmpegResolver();
    runtime.ffmpeg = { available: Boolean(path), path: path || '' };
  } catch (error) {
    runtime.ffmpeg.error = error.message;
  }
  if (!runtime.ffmpeg.available) {
    issues.push({ code: 'ffmpeg_missing', severity: requireFfmpeg ? 'error' : 'warning', message: 'FFmpeg is not available' });
  }

  return { runtime, issues };
}
