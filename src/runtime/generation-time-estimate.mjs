function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function estimateGenerationTime({ modelType = 'generic', settings = {}, frames, resolution = {}, runtime = {} } = {}) {
  const safeSettings = settings && typeof settings === 'object' ? settings : {};
  const safeResolution = resolution && typeof resolution === 'object' ? resolution : {};
  const safeRuntime = runtime && typeof runtime === 'object' ? runtime : {};
  const width = positive(safeSettings.width ?? safeResolution.width, 1024);
  const height = positive(safeSettings.height ?? safeResolution.height, 1024);
  const steps = positive(safeSettings.steps, 20);
  const video = /wan|animatediff|minimax|video/i.test(modelType);
  const outputFrames = video ? positive(frames ?? safeSettings.frames ?? safeSettings.length, 16) : 1;
  const megapixels = (width * height) / 1_000_000;
  const amd = /amd|rocm/i.test(`${safeRuntime.backend || ''} ${safeRuntime.gpu?.name || ''}`);
  const baselineMs = modelType === 'minimax_h3'
    ? (amd ? 480_000 : 360_000)
    : modelType === 'wan' ? 300_000 : modelType === 'animatediff' ? 180_000 : 45_000;
  const frameFactor = video ? Math.max(0.25, outputFrames / (modelType === 'minimax_h3' ? 124 : 81)) : 1;
  const resolutionFactor = Math.max(0.25, megapixels / (modelType === 'minimax_h3' ? 0.23 : 0.4));
  const stepFactor = Math.max(0.25, steps / 20);
  const estimatedMs = Math.max(15_000, Math.round(baselineMs * frameFactor * resolutionFactor * stepFactor));
  const variance = modelType === 'minimax_h3' ? 0.35 : video ? 0.3 : 0.2;
  return {
    modelType,
    video,
    estimatedMs,
    minMs: Math.round(estimatedMs * (1 - variance)),
    maxMs: Math.round(estimatedMs * (1 + variance)),
    basis: { width, height, megapixels: +megapixels.toFixed(3), frames: outputFrames, steps, amd },
  };
}

export function progressTimeEstimate(estimate, { startedAt = Date.now(), percent = null, now = Date.now() } = {}) {
  if (!estimate?.estimatedMs) return null;
  const elapsedMs = Math.max(0, now - startedAt);
  const normalizedPercent = Number(percent);
  const hasProgress = Number.isFinite(normalizedPercent) && normalizedPercent > 0 && normalizedPercent < 100;
  const projectedTotalMs = hasProgress ? Math.max(estimate.estimatedMs, elapsedMs / (normalizedPercent / 100)) : estimate.estimatedMs;
  return {
    elapsedMs,
    estimatedTotalMs: Math.round(projectedTotalMs),
    remainingMs: Math.max(0, Math.round(projectedTotalMs - elapsedMs)),
    confidence: hasProgress ? 'calibrated' : 'forecast',
  };
}
