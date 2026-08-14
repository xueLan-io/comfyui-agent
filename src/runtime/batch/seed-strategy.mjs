// Queue → jobs expansion for the batch queue feature.
//
// A queue item is a plan snapshot (prompt + workflow + parameters + reference
// media) plus a seed strategy. On start, each item expands into one or more
// jobs (one per resolved seed), and the whole queue is submitted as a single
// batch to the existing BatchScheduler.
//
// Pure helpers with no Node/Electron dependencies so they can be unit-tested
// and reused across the renderer and main process.

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

// Resolve a seed strategy into a concrete list of seeds.
// - random: `count` random seeds (default 4)
// - fixed:  the single seed in `value`
// - list:   each value in `values`
// - step:   `start` then +`step` repeated `count` times
export function resolveSeedStrategy(strategy = {}) {
  const mode = strategy?.mode || 'random';
  if (mode === 'fixed') {
    const seed = toInt(strategy.value);
    return [seed == null ? randomSeed() : seed];
  }
  if (mode === 'list') {
    const seeds = (Array.isArray(strategy.values) ? strategy.values : [])
      .map(toInt)
      .filter(value => value != null);
    return seeds.length ? seeds.slice(0, 200) : [randomSeed()];
  }
  if (mode === 'step') {
    const count = Math.min(Math.max(1, Number(strategy.count) || 4), 200);
    const start = toInt(strategy.start);
    const step = toInt(strategy.step);
    const base = start == null ? randomSeed() : start;
    const delta = step == null ? 1 : step;
    return Array.from({ length: count }, (_, index) => base + index * delta);
  }
  const count = Math.min(Math.max(1, Number(strategy.count) || 4), 200);
  return Array.from({ length: count }, () => randomSeed());
}

// Normalize a loose plan payload into the canonical plan shape used by jobs.
export function normalizePlan(input = {}) {
  const settings = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
    ? input.parameters
    : input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
      ? input.settings
      : {};
  const media = input.media && typeof input.media === 'object' ? input.media : {};
  return {
    positive: String(input.positive || ''),
    negative: String(input.negative || ''),
    workflowName: String(input.workflowName || input.workflow || ''),
    workflowDir: String(input.workflowDir || ''),
    parameters: { ...settings },
    nodeOverrides: input.nodeOverrides && typeof input.nodeOverrides === 'object' ? { ...input.nodeOverrides } : {},
    outputNodeIds: Array.isArray(input.outputNodeIds) ? [...input.outputNodeIds] : null,
    media: {
      images: Array.isArray(media.images) ? [...media.images] : [],
      videos: Array.isArray(media.videos) ? [...media.videos] : [],
    },
  };
}

// Expand queue items into a flat job list for a single batch submission.
export function expandQueueItems(items = []) {
  const jobs = [];
  for (const item of items || []) {
    const plan = normalizePlan(item.plan || item);
    if (!plan.positive) continue;
    const seeds = resolveSeedStrategy(item.seedStrategy);
    for (const seed of seeds) {
      jobs.push({
        positive: plan.positive,
        negative: plan.negative,
        workflowName: plan.workflowName,
        workflowDir: plan.workflowDir,
        settings: { ...plan.parameters, ...(seed !== undefined ? { seed } : {}) },
        nodeOverrides: plan.nodeOverrides,
        outputNodeIds: plan.outputNodeIds,
        media: plan.media,
        seed,
        sourceKind: item.sourceKind || 'plan',
        sourceLabel: item.sourceLabel || '',
      });
    }
  }
  return jobs;
}
