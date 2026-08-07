const BASE_VRAM_MB = {
  anima: 6144,
  sdxl: 5120,
  flux: 8192,
  wan: 10240,
  animatediff: 6144,
  minimax_h3: 12288,
  generic: 4096,
};

function number(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : fallback;
}

function memoryMb(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) return 0;
  return result > 1_000_000 ? result / (1024 * 1024) : result;
}

export function estimateGenerationResources({ modelType = 'generic', capabilities = {}, resolution = {}, settings = {}, frames, batch, runtime = {}, strict = false } = {}) {
  const safeSettings = settings && typeof settings === 'object' ? settings : {};
  const safeResolution = resolution && typeof resolution === 'object' ? resolution : {};
  const safeRuntime = runtime && typeof runtime === 'object' ? runtime : {};
  const width = number(safeSettings.width ?? safeResolution.width, 1024);
  const height = number(safeSettings.height ?? safeResolution.height, 1024);
  const outputBatch = Math.max(1, Math.floor(number(safeSettings.batch ?? batch, 1)));
  const video = capabilities.modes?.some(mode => /video/.test(mode)) || /video|wan|animatediff|minimax/i.test(modelType);
  const outputFrames = video ? Math.max(1, Math.floor(number(frames ?? safeSettings.frames ?? safeSettings.length, 16))) : 1;
  const megapixels = (width * height) / 1_000_000;
  const base = BASE_VRAM_MB[modelType] || BASE_VRAM_MB.generic;
  const resolutionFactor = Math.max(0.5, megapixels);
  const batchFactor = 1 + (outputBatch - 1) * (video ? 0.5 : 0.65);
  const frameFactor = video ? Math.max(1, outputFrames / 16) : 1;
  const estimatedVramMb = Math.ceil(base * resolutionFactor * batchFactor * frameFactor * (video ? 1.15 : 1));
  const freeVramMb = memoryMb(safeRuntime.gpu?.vramFree);
  const totalVramMb = memoryMb(safeRuntime.gpu?.vramTotal);
  const issues = [];
  if (freeVramMb > 0 && estimatedVramMb > freeVramMb * 0.9) {
    issues.push({
      code: 'vram_insufficient',
      severity: 'warning',
      message: `Estimated VRAM ${Math.ceil(estimatedVramMb)} MB exceeds the safe available budget of ${Math.floor(freeVramMb)} MB; reduce resolution, frames, or batch`,
      blocking: false,
      strictSeverity: strict && estimatedVramMb > freeVramMb * 1.15 ? 'error' : 'warning',
    });
  } else if (video && outputFrames >= 64) {
    issues.push({ code: 'video_memory_pressure', severity: 'warning', message: 'Long video generation may use substantial VRAM; reduce frames or resolution if execution becomes unstable' });
  }
  return {
    modelType,
    video,
    width,
    height,
    megapixels: +megapixels.toFixed(3),
    frames: outputFrames,
    batch: outputBatch,
    estimatedVramMb,
    availableVramMb: freeVramMb,
    totalVramMb,
    issues,
  };
}
