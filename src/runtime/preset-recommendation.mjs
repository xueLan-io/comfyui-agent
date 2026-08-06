export function recommendationScore(preset = {}, context = {}) {
  const rating = Number(preset.rating) || 0;
  const usage = Math.min(20, Number(preset.usageCount) || 0);
  const favorite = preset.favorite ? 3 : 0;
  const recency = Math.max(0, 1 - (Date.now() - (preset.lastUsedAt || preset.updatedAt || 0)) / 2592000000);
  const workflow = context.workflowName && (preset.workflowName === context.workflowName || preset.workflow === context.workflowName) ? 8 : 0;
  const tags = context.tags?.length ? context.tags.filter(tag => (preset.tags || []).includes(tag)).length * 2 : 0;
  return rating * 10 + usage + favorite + recency * 5 + workflow + tags;
}

export function sortRecommended(presets = [], context = {}) {
  return [...presets].sort((a, b) => recommendationScore(b, context) - recommendationScore(a, context));
}
