// Web research subsystem (character appearance research + chat research),
// extracted from agent.mjs. Functions operate on the agent and are
// behavior-preserving moves; the Agent methods delegate here one line each.

import { emit, AgentEventTypes } from '../events/agent-events.mjs';
import { resolveLLMStrategy } from '../llm/provider.mjs';
import { extractAppearanceFacts } from '../research/appearance.mjs';
import { normalizeResearchSettings } from '../research/settings.mjs';
import { WebTool, openResultPages } from '../tools/web/index.mjs';

const SPOKEN_PREFIX = /^(?:联网|在线|帮我|给我|请|帮忙|搜索一下|搜索|搜一下|查一?下|查查|找一?下|找找|看看|介绍一下?|推荐|现在|目前|有什么|什么|你|您|然后|顺便)[，,、\s：:]*/i;
const URL_PATTERN = /https?:\/\/[^\s，。；、""''<>]+/gi;

export async function researchCharacter(agent, request, inputSettings = {}) {
  const query = researchQueryOf(agent, request);
  const webTool = agent.tools?.web || WebTool;
  const settings = normalizeResearchSettings({
    ...inputSettings,
    baiduApiKey: inputSettings.baiduApiKey || agent.researchConfig?.baiduApiKey,
  });
  settings.allowNetwork = settings.allowNetwork && agent.sandbox?.networkEnabled !== false;
  const stepId = 'character_research';
  emit(AgentEventTypes.STEP, {
    stepId,
    tool: 'web',
    status: 'running',
    description: 'Research character appearance from public references',
    taskId: agent._taskId,
    traceId: agent._traceId,
  });
  emit(AgentEventTypes.TOOL_CALL, {
    stepId,
    tool: 'web',
    input: {
      action: 'search',
      query,
      maxResults: settings.maxResults,
      timeoutMs: settings.timeoutMs,
      allowNetwork: settings.allowNetwork,
      allowedDomains: settings.allowedDomains,
    },
    taskId: agent._taskId,
    traceId: agent._traceId,
  });

  const search = await webTool.execute({
    action: 'search',
    query,
    maxResults: settings.maxResults,
    timeoutMs: settings.timeoutMs,
    allowNetwork: settings.allowNetwork,
    cacheTtlMs: settings.cacheTtlMs,
    providers: settings.providers,
    proxyUrl: settings.proxyUrl,
    baiduApiKey: settings.baiduApiKey,
    sourcePolicy: settings,
  });
  if (search.error) {
    emit(AgentEventTypes.TOOL_RESULT, { stepId, tool: 'web', success: false, error: search.error, taskId: agent._taskId, traceId: agent._traceId });
    const researchStatus = search.researchStatus || (settings.allowNetwork ? 'search_failed' : 'disabled');
    emit(AgentEventTypes.STEP, { stepId, tool: 'web', status: 'warning', description: 'Character reference research unavailable', error: search.error, researchStatus, taskId: agent._taskId, traceId: agent._traceId });
    return { query, ...emptyAppearanceFacts(), sources: [], researchStatus, researchMessage: settings.allowNetwork ? `未使用在线资料：${search.error}` : search.error };
  }

  const pages = await openResultPages(webTool, search.results, settings);
  const rawContext = researchContextOf(agent, search, pages);
  let appearanceFacts;
  let researchStatus = rawContext.sources.length > 0 ? 'complete' : 'no_sources';
  try {
    appearanceFacts = await extractAppearanceFacts(agent.llm, rawContext.sources);
  } catch {
    appearanceFacts = emptyAppearanceFacts();
    researchStatus = 'extraction_failed';
  }
  const context = {
    query: rawContext.query,
    ...appearanceFacts,
    sources: rawContext.sources.map(source => ({ title: source.title, url: source.url, trustLevel: source.trustLevel })),
    researchStatus,
  };
  emit(AgentEventTypes.TOOL_RESULT, {
    stepId,
    tool: 'web',
    success: true,
    result: {
      query: context.query,
      sources: context.sources,
      appearanceFacts: {
        hair: context.hair,
        eyes: context.eyes,
        outfit: context.outfit,
        accessories: context.accessories,
        silhouette: context.silhouette,
        evidence: context.evidence,
      },
      researchStatus: context.researchStatus,
    },
    taskId: agent._taskId,
    traceId: agent._traceId,
  });
  emit(AgentEventTypes.STEP, {
    stepId,
    tool: 'web',
    status: 'completed',
    description: `Collected ${context.sources.length} character references and extracted appearance facts`,
    taskId: agent._taskId,
    traceId: agent._traceId,
  });
  return context;
}

// 口语消息 → 搜索关键词。cn.bing 对中文口语长句解析很差（"帮我查一下"只剩"帮"），
// 优先用 LLM 提炼，失败时用规则剥离口语前缀兜底
export async function buildSearchQuery(agent, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) return '';
  if (agent.llm?.isConfigured) {
    try {
      const result = await agent.llm.chat({
        messages: [
          { role: 'system', content: '你是搜索关键词提炼器。把用户的口语化请求改写成适合搜索引擎的关键词（可含英文），只输出关键词本身，不要解释、标点或引号。' },
          { role: 'user', content: trimmed },
        ],
        temperature: 0,
        maxTokens: 40,
        timeoutMs: 10000,
        prefer: resolveLLMStrategy(agent.llm),
      });
      const keywords = String(result?.content || '').trim().replace(/[「」“”"']/g, '');
      if (keywords && keywords.length <= 80 && !keywords.includes('：')) return keywords;
    } catch {}
  }
  let query = trimmed;
  for (let i = 0; i < 5 && SPOKEN_PREFIX.test(query); i++) query = query.replace(SPOKEN_PREFIX, '');
  return query.trim() || trimmed;
}

export async function chatResearch(agent, message, settings) {
  settings = normalizeResearchSettings({
    ...settings,
    baiduApiKey: settings.baiduApiKey || agent.researchConfig?.baiduApiKey,
  });
  settings.allowNetwork = settings.allowNetwork && agent.sandbox?.networkEnabled !== false;
  const webTool = agent.tools?.web || WebTool;
  const stepId = 'chat_research';
  const trimmed = String(message || '').trim();
  const urls = [...new Set(trimmed.match(URL_PATTERN) || [])].slice(0, Math.max(settings.maxOpenPages || 2, 1));
  const query = await agent._buildSearchQuery(trimmed.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim());
  if (!query && urls.length === 0) return { query: trimmed, sources: [], status: 'empty', message: '空的研究请求' };
  emit(AgentEventTypes.STEP, { stepId, tool: 'web', status: 'running', description: '正在联网检索公开资料', taskId: agent._taskId, traceId: agent._traceId });
  const sources = [];
  const seen = new Set();
  const failures = [];
  let answer = '';
  const openPage = async (url) => {
    const result = await webTool.execute({ action: 'open', url, timeoutMs: settings.timeoutMs, allowNetwork: settings.allowNetwork, cacheTtlMs: settings.cacheTtlMs, proxyUrl: settings.proxyUrl, sourcePolicy: settings });
    if (result.error) { failures.push(`open ${url}: ${result.error}`); return null; }
    return result.page;
  };
  const addSource = (source) => {
    if (!source || (!source.content && !source.snippet) || !source.url) return;
    const key = source.url.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ title: source.title || '', url: source.url, snippet: source.snippet || '', trustLevel: source.trustLevel || 'unknown', content: (source.content || '').slice(0, 5000) });
  };
  let pageBudget = Math.max(settings.maxOpenPages || 3, 0);
  for (const url of urls) {
    emit(AgentEventTypes.TOOL_CALL, { stepId, tool: 'web', input: { action: 'open', url }, taskId: agent._taskId, traceId: agent._traceId });
    const page = await openPage(url);
    if (page) addSource({ title: page.title, url: page.url, snippet: page.description, trustLevel: page.trustLevel, content: page.content });
  }
  pageBudget -= urls.length;
  if (query) {
    emit(AgentEventTypes.TOOL_CALL, { stepId, tool: 'web', input: { action: 'search', query }, taskId: agent._taskId, traceId: agent._traceId });
    const search = await webTool.execute({ action: 'search', query, maxResults: settings.maxResults, timeoutMs: settings.timeoutMs, allowNetwork: settings.allowNetwork, cacheTtlMs: settings.cacheTtlMs, proxyUrl: settings.proxyUrl, baiduApiKey: settings.baiduApiKey, sourcePolicy: settings, providers: settings.providers });
    answer = search.answer || '';
    if (search.error) failures.push(`search: ${search.error}`);
    else {
      for (const item of search.results || []) {
        let page = null;
        if (pageBudget > 0) { page = await openPage(item.url); pageBudget--; }
        if (page) addSource({ title: page.title, url: page.url, snippet: page.description, trustLevel: page.trustLevel, content: page.content });
        else addSource({ title: item.title, url: item.url, snippet: item.snippet, trustLevel: item.trustLevel, content: item.snippet });
      }
    }
  }
  const list = sources.slice(0, 5);
  const status = list.length > 0 ? 'complete' : 'no_sources';
  emit(AgentEventTypes.TOOL_RESULT, {
    stepId, tool: 'web', success: list.length > 0,
    result: { query: query || urls[0] || '', sources: list, status },
    error: list.length > 0 ? undefined : failures.join('; ') || undefined,
    taskId: agent._taskId, traceId: agent._traceId,
  });
  emit(AgentEventTypes.STEP, {
    stepId, tool: 'web', status: status === 'complete' ? 'completed' : 'error',
    description: status === 'complete' ? `已收集 ${list.length} 条公开资料` : '在线检索未返回可用资料',
    taskId: agent._taskId, traceId: agent._traceId,
  });
  return { query: query || urls[0] || '', sources: list, answer, message: failures.join('; '), status };
}

// --- local helpers referenced by the extracted methods (moved verbatim) ---

function researchQueryOf(agent, request) {
  return `${String(request).trim().slice(0, 240)} character appearance hair eyes outfit accessories official design reference`;
}

function researchContextOf(agent, result, pages) {
  const sources = (result.results || []).map((item, index) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet || '',
    trustLevel: item.trustLevel || pages[index]?.page?.trustLevel || 'unknown',
    content: (pages[index]?.page?.content || '').slice(0, 5000),
  })).filter(item => item.snippet || item.content).slice(0, 5);
  return {
    query: result.query || '',
    sources,
  };
}

function emptyAppearanceFacts() {
  return { hair: '', eyes: '', outfit: '', accessories: '', silhouette: '', evidence: [] };
}
