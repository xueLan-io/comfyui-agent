// Web research subsystem (character appearance research + chat research),
// extracted from agent.mjs. Functions operate on the agent and are
// behavior-preserving moves; the Agent methods delegate here one line each.

import { emit, AgentEventTypes } from '../events/agent-events.mjs';
import { resolveLLMStrategy } from '../llm/provider.mjs';
import { extractAppearanceFacts } from '../research/appearance.mjs';
import { normalizeResearchSettings } from '../research/settings.mjs';
import { WebTool, openResultPages } from '../tools/web/index.mjs';

const SPOKEN_PREFIX = /^(?:联网|在线|帮我|给我|请|帮忙|使用搜索|搜索一下|搜索|搜一下|查一?下|查查|找一?下|找找|看看|介绍一下?|推荐|现在|目前|有什么|什么|你|您|然后|顺便)[，,、\s：:]*/i;
const URL_PATTERN = /https?:\/\/[^\s，。；、""''<>]+/gi;

const GENERATION_HINTS = /(?:生成|画|绘制|立绘|出图|生图|prompt|generate|draw|render|create|make)/i;
const CHARACTER_RESEARCH_HINTS = /(?:角色|人物|立绘|人设|外观|服装|发型|发色|眼睛|还原|原作|设定|官方设定|搜索|查找|查一下|资料|网上|character|appearance|outfit|costume|hair|eyes|canon|reference|search|research|look up)/i;
const CHARACTER_SOURCE_HINTS = /(?:原神|崩坏|明日方舟|碧蓝航线|绝区零|鸣潮|fate|blue archive|genshin|honkai|arknights|character)/i;

// 出图请求的外观调研触发启发式（v0.3.6 曾无条件保证该链路），
// 作为规划器输出 web 步骤之外的可靠兜底。
export function shouldResearchCharacter(request, intent) {
  if (intent !== 'generate' || !GENERATION_HINTS.test(request)) return false;
  return CHARACTER_RESEARCH_HINTS.test(request) || CHARACTER_SOURCE_HINTS.test(request);
}

export async function researchCharacter(agent, request, inputSettings = {}, stepDescription = '', preferredQuery = '') {
  const query = await researchQueryOf(agent, request, preferredQuery);
  const webTool = agent.tools?.web || WebTool;
  const settings = normalizeResearchSettings({
    ...inputSettings,
    baiduApiKey: inputSettings.baiduApiKey || agent.researchConfig?.baiduApiKey,
    searchApi: inputSettings.searchApi || agent.researchConfig?.searchApi,
    searchApiKey: inputSettings.searchApiKey || agent.researchConfig?.searchApiKey,
    searchApiBaseUrl: inputSettings.searchApiBaseUrl || agent.researchConfig?.searchApiBaseUrl,
  });
  settings.allowNetwork = settings.allowNetwork && agent.sandbox?.networkEnabled !== false;
  const stepId = 'character_research';
  const description = stepDescription || 'Research character appearance from public references';
  emit(AgentEventTypes.STEP, {
    stepId,
    tool: 'web',
    status: 'running',
    description,
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
    searchApi: settings.searchApi,
    searchApiKey: settings.searchApiKey,
    searchApiBaseUrl: settings.searchApiBaseUrl,
    sourcePolicy: settings,
  });
  if (search.error) {
    const attempted = Array.isArray(search.attempted) ? search.attempted : [];
    emit(AgentEventTypes.TOOL_RESULT, {
      stepId, tool: 'web', success: false, error: search.error,
      result: { query, attempted, provider: '', sources: [] },
      taskId: agent._taskId, traceId: agent._traceId,
    });
    const researchStatus = search.researchStatus || (settings.allowNetwork ? 'search_failed' : 'disabled');
    emit(AgentEventTypes.STEP, { stepId, tool: 'web', status: 'warning', description: 'Character reference research unavailable', error: search.error, researchStatus, taskId: agent._taskId, traceId: agent._traceId });
    return { query, attempted, provider: '', ...emptyAppearanceFacts(), sources: [], researchStatus, researchMessage: settings.allowNetwork ? `未使用在线资料：${search.error}` : search.error };
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
    provider: search.provider || '',
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
      provider: context.provider,
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
    description: stepDescription || `Collected ${context.sources.length} character references and extracted appearance facts`,
    taskId: agent._taskId,
    traceId: agent._traceId,
  });
  return context;
}

// 《作品名》书名号与"中的/角色/人物"后的实体名是搜索关键词的核心锚点：
// LLM 口语化改写时容易丢字，这里在提炼前确定性抽取，提炼后校验并补回。
function extractSearchAnchors(text) {
  const anchors = [];
  const seen = new Set();
  const push = value => {
    const key = String(value || '').trim();
    if (key && !seen.has(key)) { seen.add(key); anchors.push(key); }
  };
  for (const match of String(text).matchAll(/《([^《》]+)》/g)) push(match[0]);
  // 从去掉书名号的文本里找"中的/角色/人物"后的实体，避免把《角色扮演游戏》误当实体标记
  const withoutTitles = String(text).replace(/《[^《》]*》/g, ' ');
  const entity = withoutTitles.match(/(?:中的角色|中的|角色|人物)\s*([^\s，。；、？?！!「」""''《》的]+)/);
  if (entity) push(entity[1]);
  // 也覆盖省略“中的角色”的自然表达，如“《原神》 沃雅妮莎 介绍”。
  // 只接受紧邻作品名、且后面接明确资料意图的短词，避免把整句口语当成实体。
  const titleEntity = String(text).match(/《[^《》]+》\s*((?!(?:中的|角色|人物))[^\s，。；、？?！!「」""''《》]+)(?=(?:\s+|的)(?:外貌|外观|介绍|资料|设定|信息|背景|图片|立绘|服装|发型|眼睛|形象|故事|档案))/);
  if (titleEntity) push(titleEntity[1]);
  return anchors;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 确定性补回锚点：完整《》形式缺失时，若裸核心词（如"原神"）还在就只补回书名号；
// 完全缺失则把锚点补到关键词前面，保证作品名/专有名词不因改写而丢失。
function preserveSearchAnchors(keywords, anchors) {
  const result = String(keywords || '').trim();
  if (!result) return anchors.join(' ');
  const additions = [];
  let output = result;
  for (const anchor of anchors) {
    if (output.includes(anchor)) continue;
    const core = anchor.replace(/^《|》$/g, '');
    const pattern = core === anchor ? null : new RegExp(`(?<![\\p{Script=Han}A-Za-z0-9])${escapeRegExp(core)}(?![\\p{Script=Han}A-Za-z0-9])`, 'u');
    if (pattern && pattern.test(output)) output = output.replace(pattern, anchor);
    else additions.push(anchor);
  }
  return additions.length > 0 ? [...additions, output].filter(Boolean).join(' ') : output;
}

// 口语消息 → 搜索关键词。cn.bing 对中文口语长句解析很差（"帮我查一下"只剩"帮"），
// 优先用 LLM 提炼，失败时用规则剥离口语前缀兜底。
export async function buildSearchQuery(agent, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) return '';
  const anchors = extractSearchAnchors(trimmed);
  if (agent.llm?.isConfigured) {
    try {
      const result = await agent.llm.chat({
        messages: [
          { role: 'system', content: '你是搜索关键词提炼器。把用户的口语化请求改写成适合搜索引擎的关键词（可含英文），只输出关键词本身，不要解释。必须原样保留《》作品名和专有名词（例如《原神》、沃雅妮莎），不得省略、改写或去掉书名号。' },
          { role: 'user', content: trimmed },
        ],
        temperature: 0,
        maxTokens: 40,
        timeoutMs: 10000,
        prefer: resolveLLMStrategy(agent.llm),
      });
      const keywords = String(result?.content || '').trim().replace(/[「」“”"']/g, '');
      if (keywords && keywords.length <= 80 && !keywords.includes('：')) return preserveSearchAnchors(keywords, anchors);
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
    searchApi: settings.searchApi || agent.researchConfig?.searchApi,
    searchApiKey: settings.searchApiKey || agent.researchConfig?.searchApiKey,
    searchApiBaseUrl: settings.searchApiBaseUrl || agent.researchConfig?.searchApiBaseUrl,
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
  let provider = '';
  let attempted = [];
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
    const search = await webTool.execute({ action: 'search', query, maxResults: settings.maxResults, timeoutMs: settings.timeoutMs, allowNetwork: settings.allowNetwork, cacheTtlMs: settings.cacheTtlMs, proxyUrl: settings.proxyUrl, baiduApiKey: settings.baiduApiKey, searchApi: settings.searchApi, searchApiKey: settings.searchApiKey, searchApiBaseUrl: settings.searchApiBaseUrl, sourcePolicy: settings, providers: settings.providers });
    answer = search.answer || '';
    provider = search.provider || '';
    attempted = Array.isArray(search.attempted) ? search.attempted : [];
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
    result: { query: query || urls[0] || '', provider, attempted, sources: list, status },
    error: list.length > 0 ? undefined : failures.join('; ') || undefined,
    taskId: agent._taskId, traceId: agent._traceId,
  });
  emit(AgentEventTypes.STEP, {
    stepId, tool: 'web', status: status === 'complete' ? 'completed' : 'error',
    description: status === 'complete' ? `已收集 ${list.length} 条公开资料` : '在线检索未返回可用资料',
    taskId: agent._taskId, traceId: agent._traceId,
  });
  return { query: query || urls[0] || '', provider, attempted, sources: list, answer, message: failures.join('; '), status };
}

// --- local helpers referenced by the extracted methods (moved verbatim) ---

async function researchQueryOf(agent, request, preferredQuery = '') {
  const trimmed = String(request).trim().slice(0, 240);
  // 优先采用规划器 web 步骤里写好的 query（LLM 已按用户意图提炼过）；
  // 否则用 LLM 提炼搜索关键词（剥离"生成一张"等祈使前缀），失败时回退到原文。
  const base = String(preferredQuery || '').trim()
    || (await buildSearchQuery(agent, trimmed))
    || trimmed;
  return `${base} character appearance hair eyes outfit accessories official design reference`;
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

// 生成计划里若包含 web 调研步骤，就在提示词编译前先跑完角色调研，
// 把外观事实写入 ctx.characterResearch，并移除已消费的 web 步骤，
// 避免执行阶段再跑一次、以及调研结果永远到不了提示词编译器。
// options.force = true 时即使规划器没有输出 web 步骤也强制执行调研
// （例如意图路由器判定 needsResearch、或启发式命中角色外观请求），
// 恢复 v0.3.6「出图路径保证调研」的语义。
// 返回 true 表示已消费（并移除）计划里的 web 步骤。
export async function researchCharacterIfPlanned(agent, plan, ctx, request, options = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const researchStep = steps.find(step => step?.tool === 'web');
  const hasResearchStep = Boolean(researchStep);
  const forced = options.force === true;
  if (!hasResearchStep && !forced) return false;

  const networkEnabled = agent.sandbox?.networkEnabled !== false && agent.researchConfig?.allowNetwork !== false;
  const emptyResult = (status, message) => ({
    query: String(request).trim().slice(0, 300),
    ...emptyAppearanceFacts(),
    sources: [],
    researchStatus: status,
    researchMessage: message,
  });
  if (!networkEnabled) {
    ctx.characterResearch = emptyResult('disabled', 'Online research is disabled');
  } else {
    try {
      ctx.characterResearch = await researchCharacter(agent, request, agent.project?.get?.('researchSettings') || {}, researchStep?.description || '', researchStep?.input?.query || '');
    } catch {
      ctx.characterResearch = emptyResult('search_failed', 'Character research failed');
    }
  }

  if (hasResearchStep) {
    plan.steps = steps.filter(step => step?.tool !== 'web');
    const remainingIds = new Set(plan.steps.map(step => step?.id).filter(Boolean));
    for (const step of plan.steps) {
      if (Array.isArray(step?.depends_on)) step.depends_on = step.depends_on.filter(id => remainingIds.has(id));
    }
  }
  return hasResearchStep;
}
