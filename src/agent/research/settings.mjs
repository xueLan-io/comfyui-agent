export const DEFAULT_RESEARCH_SETTINGS = {
  allowNetwork: true,
  baiduApiKey: '',
  providers: ['bing', 'duckduckgo', 'baidu'],
  proxyUrl: '',
  maxResults: 5,
  maxOpenPages: 3,
  timeoutMs: 12000,
  cacheTtlMs: 300000,
  allowedDomains: [],
  officialDomains: [],
  verifiedDomains: [],
  communityDomains: [],
};

function domains(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
    .map(item => String(item).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, ''))
    .filter(Boolean))].slice(0, 50);
}

function providers(value, fallback) {
  const list = [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
    .map(item => String(item).trim().toLowerCase())
    .filter(Boolean))].slice(0, 10);
  return list.length > 0 ? list : fallback;
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function normalizeResearchSettings(value = {}) {
  const next = { ...DEFAULT_RESEARCH_SETTINGS, ...(value || {}) };
  return {
    allowNetwork: next.allowNetwork !== false,
    baiduApiKey: String(next.baiduApiKey || '').trim(),
    providers: providers(next.providers, DEFAULT_RESEARCH_SETTINGS.providers),
    proxyUrl: String(next.proxyUrl || '').trim(),
    maxResults: integer(next.maxResults, DEFAULT_RESEARCH_SETTINGS.maxResults, 1, 10),
    maxOpenPages: integer(next.maxOpenPages, DEFAULT_RESEARCH_SETTINGS.maxOpenPages, 0, 10),
    timeoutMs: integer(next.timeoutMs, DEFAULT_RESEARCH_SETTINGS.timeoutMs, 1000, 30000),
    cacheTtlMs: integer(next.cacheTtlMs, DEFAULT_RESEARCH_SETTINGS.cacheTtlMs, 0, 86400000),
    allowedDomains: domains(next.allowedDomains),
    officialDomains: domains(next.officialDomains),
    verifiedDomains: domains(next.verifiedDomains),
    communityDomains: domains(next.communityDomains),
  };
}
