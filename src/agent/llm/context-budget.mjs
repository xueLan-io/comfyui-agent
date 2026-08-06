import { estimateTokens } from '../optimizer/prompt-guard.mjs';

export const DEFAULT_CONTEXT_PROFILES = {
  local: {
    mode: 'local',
    maxInputTokens: 12288,
    maxRecentTurns: 8,
    maxToolResultTokens: 1800,
    archiveStrategy: 'extractive-first',
  },
  cloud: {
    mode: 'cloud',
    maxInputTokens: 0,
    maxRecentTurns: 20,
    maxToolResultTokens: 8000,
    archiveStrategy: 'relevance-first',
  },
};

export function contextProfileFor({ kind = 'cloud', contextWindow = 32768, profile = {} } = {}) {
  const defaults = DEFAULT_CONTEXT_PROFILES[kind] || DEFAULT_CONTEXT_PROFILES.cloud;
  const configured = Number(profile.maxInputTokens);
  const maxInputTokens = configured > 0
    ? configured
    : defaults.maxInputTokens > 0
      ? Math.min(defaults.maxInputTokens, contextWindow)
      : contextWindow;
  return {
    ...defaults,
    ...profile,
    mode: kind,
    contextWindow,
    maxInputTokens: Math.max(1, Math.min(maxInputTokens, contextWindow)),
  };
}

export function contextTelemetry({
  messages = [],
  contextWindow = 32768,
  inputBudget = contextWindow,
  reservedOutputTokens = 0,
  droppedMessageCount = 0,
  truncated = false,
  source = 'estimate',
  providerUsage = null,
  kind = 'cloud',
  stage = 'chat',
  archiveCount = 0,
} = {}) {
  const inputTokensEstimated = messages.reduce((total, message) => {
    const text = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('\n')
        : '';
    const media = Array.isArray(message?.content) && message.content.some(part => part?.type === 'image' || part?.type === 'image_url') ? 256 : 0;
    return total + estimateTokens(text) + media;
  }, 0);
  const occupancyTokens = inputTokensEstimated + Math.max(0, reservedOutputTokens);
  const usage = providerUsage && Number.isFinite(providerUsage.inputTokens)
    ? providerUsage
    : null;
  const measuredInputTokens = usage?.inputTokens ?? inputTokensEstimated;
  const measuredOutputTokens = usage?.outputTokens ?? Math.max(0, reservedOutputTokens);
  const measuredTotalTokens = usage?.totalTokens ?? measuredInputTokens + measuredOutputTokens;
  const measuredOccupancyTokens = usage ? measuredInputTokens + measuredOutputTokens : occupancyTokens;
  return {
    stage,
    mode: kind,
    contextWindow,
    inputBudget,
    inputTokensEstimated,
    inputTokens: measuredInputTokens,
    outputTokens: measuredOutputTokens,
    totalTokens: measuredTotalTokens,
    reservedOutputTokens: Math.max(0, reservedOutputTokens),
    occupancyTokens: measuredOccupancyTokens,
    occupancyPercent: Math.min(100, Math.round((measuredOccupancyTokens / Math.max(1, inputBudget)) * 100)),
    remainingTokens: Math.max(0, inputBudget - measuredOccupancyTokens),
    truncated: Boolean(truncated),
    droppedMessageCount,
    archiveCount,
    source: usage ? 'provider' : source,
  };
}
