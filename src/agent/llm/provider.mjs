import { OpenAICompatibleProvider } from './openai-compatible.mjs';
import { OllamaProvider } from './ollama.mjs';
import { CloudPolicyBlockedError, CloudPolicyRouter } from './cloud-policy-router.mjs';
import { sanitizeMessages } from '../schemas/context-sanitizer.mjs';
import { debugLog } from './debug-log.mjs';
import { estimateTokens } from '../optimizer/prompt-guard.mjs';
import { contextProfileFor, contextTelemetry } from './context-budget.mjs';

const STRATEGIES = ['auto', 'local', 'cloud', 'manual'];

const MIN_LOCAL_MAX_TOKENS = 1024;
const MAX_LOCAL_OUTPUT_TOKENS = 2048;
const DEFAULT_CONTEXT_WINDOW = 32768;
const HEALTH_TTL_MS = 10000;
const CONTEXT_RESERVE_TOKENS = 512;

function isCancellationError(error, signal) {
  return Boolean(
    signal?.aborted
      || error?.code === 'LLM_CANCELLED'
      || error?.name === 'AbortError'
      || /取消|cancelled|canceled/i.test(String(error?.message || '')),
  );
}

export function resolveLLMStrategy(provider) {
  return provider?.strategy === 'local' || provider?.strategy === 'cloud'
    ? provider.strategy
    : undefined;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('\n');
}

function policyRequestKey(options, route, active, allowMediaToCloud) {
  const entryKey = entry => entry ? {
    id: entry.provider?.id || '',
    kind: entry.kind || '',
    model: entry.provider?.id === active?.providerId
      ? active?.modelId || ''
      : entry.provider?.models?.find(model => model.kind !== 'image' && model.enabled !== false)?.id || '',
  } : null;
  return JSON.stringify({
    messages: options.messages || [],
    cloudSystemPrompt: options.cloudSystemPrompt || '',
    prefer: options.prefer || '',
    strategy: active?.strategy || route?.strategy || '',
    primary: entryKey(route?.primary),
    fallback: entryKey(route?.fallback),
    allowMediaToCloud: allowMediaToCloud !== false,
    allowPolicyOverride: options.allowPolicyOverride === true,
  });
}

function messageTokens(message) {
  const textTokens = estimateTokens(messageText(message?.content));
  const mediaTokens = Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url' || part?.type === 'image') ? 256 : 0;
  return textTokens + mediaTokens;
}

function trimText(text, budget) {
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function fitMessage(message, budget) {
  if (messageTokens(message) <= budget) return message;
  if (typeof message.content === 'string') return { ...message, content: trimText(message.content, budget) };
  if (!Array.isArray(message.content)) return null;
  let remaining = Math.max(0, budget - (message.content.some(part => part?.type === 'image_url' || part?.type === 'image') ? 256 : 0));
  const content = [];
  for (const part of message.content) {
    if (part?.type === 'image_url' || part?.type === 'image') {
      if (budget >= 256) content.push(part);
      continue;
    }
    if (part?.type === 'text' && remaining > 0) {
      const text = trimText(String(part.text || ''), remaining);
      if (text) {
        content.push({ ...part, text });
        remaining -= estimateTokens(text);
      }
    }
  }
  return content.length > 0 ? { ...message, content } : null;
}

export function fitMessagesToContext(messages = [], maxInputTokens = DEFAULT_CONTEXT_WINDOW) {
  const input = Array.isArray(messages) ? messages : [];
  const limit = Math.max(0, Math.floor(maxInputTokens));
  if (input.reduce((total, message) => total + messageTokens(message), 0) <= limit) return input;

  let remaining = limit;
  const systems = [];
  const conversation = [];
  for (const message of input) {
    if (message?.role === 'system') systems.push(message);
    else conversation.push(message);
  }

  // Reserve room for the current request before fitting a large system prompt.
  // Without this, a small-context model can receive only instructions and lose
  // the newest user turn after the first exchange.
  const latestConversation = conversation.pop();
  const latestBudget = latestConversation
    ? Math.min(messageTokens(latestConversation), Math.max(1, Math.floor(limit * 0.35)))
    : 0;
  const fittedLatest = latestConversation ? fitMessage(latestConversation, latestBudget) : null;
  remaining = Math.max(0, limit - (fittedLatest ? messageTokens(fittedLatest) : 0));
  const keptSystems = [];
  for (const message of systems) {
    if (remaining <= 0) break;
    const fitted = fitMessage(message, remaining);
    if (!fitted) continue;
    keptSystems.push(fitted);
    remaining -= messageTokens(fitted);
  }

  const keptConversation = [];
  for (let index = conversation.length - 1; index >= 0 && remaining > 0; index--) {
    const fitted = fitMessage(conversation[index], remaining);
    if (!fitted) continue;
    keptConversation.unshift(fitted);
    remaining -= messageTokens(fitted);
  }
  return [...keptSystems, ...keptConversation, ...(fittedLatest ? [fittedLatest] : [])];
}

export function fitMessagesWithTelemetry(messages = [], {
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  inputBudget = contextWindow,
  reservedOutputTokens = 0,
  kind = 'cloud',
  stage = 'chat',
  archiveCount = 0,
} = {}) {
  const input = Array.isArray(messages) ? messages : [];
  // Reserve output room inside the context window before fitting input, so a
  // full conversation cannot leave zero budget for the model's reply.
  const fitted = fitMessagesToContext(input, Math.max(0, Math.floor(inputBudget) - Math.max(0, reservedOutputTokens)));
  const keptIds = new Set(fitted);
  const droppedMessageCount = input.filter(message => !keptIds.has(message)).length;
  const originalTokens = input.reduce((total, message) => total + messageTokens(message), 0);
  const fittedTokens = fitted.reduce((total, message) => total + messageTokens(message), 0);
  return {
    messages: fitted,
    telemetry: contextTelemetry({
      messages: fitted,
      contextWindow,
      inputBudget,
      reservedOutputTokens,
      droppedMessageCount,
      truncated: droppedMessageCount > 0 || fittedTokens < originalTokens,
      kind,
      stage,
      archiveCount,
    }),
  };
}

function isLocalHost(baseUrl = '') {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

export function providerKind(provider = {}) {
  if (provider.type === 'ollama') return 'local';
  if (provider.type === 'openai-compatible' && isLocalHost(provider.baseUrl)) return 'local';
  return 'cloud';
}

function configuredProvider(provider = {}) {
  if (!provider || provider.apiKeyError) return null;
  const hasModel = Array.isArray(provider.models) && provider.models.some(model => model.id && model.kind !== 'image' && model.enabled !== false);
  if (!hasModel) return null;
  if (provider.type === 'ollama') return provider;
  return provider.baseUrl || provider.apiKey ? provider : null;
}

function normalizeSource(config = {}) {
  if (Array.isArray(config.providers)) return { providers: config.providers, active: config.active || {} };
  const type = config.provider || (config.providerId === 'ollama' ? 'ollama' : 'openai-compatible');
  const id = config.providerId || (type === 'ollama' ? 'ollama' : 'openai');
  return {
    providers: [{
      id,
      type,
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey || '',
      apiKeyError: config.apiKeyError || '',
      headers: config.headers || {},
      models: config.model ? [{ id: config.model, name: config.model, contextWindow: config.contextWindow }] : [],
      contextWindow: config.contextWindow || DEFAULT_CONTEXT_WINDOW,
    }],
    active: {
      providerId: id,
      modelId: config.model || '',
      reasoningEffort: config.reasoningEffort || 'medium',
      strategy: STRATEGIES.includes(config.strategy) ? config.strategy : 'manual',
    },
  };
}

function resolveActiveConfig({ providers, active }) {
  const provider = providers.find(item => item.id === active.providerId) || providers[0] || {};
  const model = provider.models?.find(item => item.id === active.modelId && item.kind !== 'image' && item.enabled !== false)
    || provider.models?.find(item => item.kind !== 'image' && item.enabled !== false)
    || {};
  return {
    provider: provider.type || (provider.id === 'ollama' ? 'ollama' : 'openai-compatible'),
    providerId: provider.id,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
    apiKeyError: provider.apiKeyError || '',
    headers: provider.headers || {},
    model: model.id || active.modelId || '',
    reasoningEffort: active.reasoningEffort || 'medium',
    contextWindow: Number(model.contextWindow || provider.contextWindow) > 0 ? Number(model.contextWindow || provider.contextWindow) : DEFAULT_CONTEXT_WINDOW,
  };
}

function modelConfigFor(provider, active) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const chatModels = models.filter(model => model.kind !== 'image' && model.enabled !== false);
  if (provider.id === active.providerId) return chatModels.find(item => item.id === active.modelId) || chatModels[0] || {};
  return chatModels[0] || {};
}

function contextWindowFor(provider, active) {
  const model = modelConfigFor(provider, active);
  return Number(model.contextWindow || provider.contextWindow) > 0 ? Number(model.contextWindow || provider.contextWindow) : DEFAULT_CONTEXT_WINDOW;
}

function modelFor(provider, active) {
  const models = Array.isArray(provider.models) ? provider.models.filter(model => model.kind !== 'image' && model.enabled !== false) : [];
  if (provider.id === active.providerId) {
    const found = models.find(item => item.id === active.modelId);
    if (found) return found.id;
  }
  return models[0]?.id || '';
}

function modelConfigForVision(provider, active) {
  const models = Array.isArray(provider.models) ? provider.models.filter(model => model.kind !== 'image' && model.enabled !== false) : [];
  if (provider.id === active.providerId) {
    const found = models.find(item => item.id === active.modelId);
    if (found) return found;
  }
  return models[0] || {};
}

function createInstance(provider, active) {
  const model = modelFor(provider, active);
  if (provider.type === 'ollama') return new OllamaProvider({ baseUrl: provider.baseUrl, model, contextWindow: contextWindowFor(provider, active), vision: Boolean(modelConfigForVision(provider, active).vision) });
  const local = providerKind(provider) === 'local';
  return new OpenAICompatibleProvider({
    baseUrl: provider.baseUrl,
    model,
    apiKey: provider.apiKey || '',
    apiKeyError: provider.apiKeyError || '',
    headers: provider.headers || {},
    reasoningEffort: local ? '' : active.reasoningEffort || 'medium',
    local,
    contextWindow: contextWindowFor(provider, active),
    vision: Boolean(modelConfigForVision(provider, active).vision),
  });
}

export function resolveLLMRouting(config = {}) {
  const { providers, active } = normalizeSource(config);
  const strategy = STRATEGIES.includes(active.strategy) ? active.strategy : 'auto';
  const usable = providers.filter(configuredProvider);
  const groups = { local: [], cloud: [] };
  for (const provider of usable) groups[providerKind(provider)].push(provider);

  let chosen = null;
  if (strategy === 'manual') {
    chosen = usable.find(item => item.id === active.providerId) || usable[0] || null;
  } else if (strategy === 'local' || strategy === 'cloud') {
    const candidates = groups[strategy];
    chosen = candidates.find(item => item.id === active.providerId) || candidates[0] || null;
  } else {
    chosen = usable.find(item => item.id === active.providerId) || groups.local[0] || groups.cloud[0] || usable[0] || null;
  }
  return {
    strategy,
    kind: chosen ? providerKind(chosen) : null,
    providerId: chosen?.id || '',
    providerName: chosen?.name || '',
    modelId: chosen ? (chosen.models?.some(model => model.kind !== 'image' && model.enabled !== false && model.id === active.modelId) ? active.modelId : chosen.models?.find(model => model.kind !== 'image' && model.enabled !== false)?.id || '') : '',
  };
}

export class LLMProvider {
  constructor(config) {
    this.sourceConfig = config || {};
    this._policyStateHandler = null;
    this.rebuild();
  }

  setPolicyStateHandler(handler) {
    this._policyStateHandler = handler;
  }

  _createPolicyRouter() {
    return new CloudPolicyRouter({ onStateChange: this._policyStateHandler });
  }

  reconfigure(config) {
    const isProviderTable = Array.isArray(config?.providers);
    this.sourceConfig = isProviderTable ? config : { ...this.sourceConfig, ...config };
    this.rebuild();
  }

  rebuild() {
    const { providers, active } = normalizeSource(this.sourceConfig);
    this.active = active;
    this.strategy = STRATEGIES.includes(active.strategy) ? active.strategy : 'auto';
    this.config = resolveActiveConfig({ providers, active });
    this._instances = new Map();
    this._pool = { local: [], cloud: [] };
    this._allowMediaToCloud = this.sourceConfig.allowMediaToCloud !== false;
    for (const provider of providers) {
      if (!configuredProvider(provider)) continue;
      const entry = {
        instance: createInstance(provider, active),
        provider,
        kind: providerKind(provider),
        ollama: provider.type === 'ollama',
        contextWindow: contextWindowFor(provider, active),
        lock: Promise.resolve(),
      };
      this._instances.set(provider.id, entry);
      this._pool[entry.kind].push(entry);
    }
    const manual = configuredProvider(providers.find(item => item.id === active.providerId)) || configuredProvider(providers[0]);
    this._manual = manual ? this._instances.get(manual.id) || null : null;
    this._active = null;
    this._health = new Map();
  }

  async _route(prefer = '') {
    if (this.strategy === 'manual') return this._manual ? { primary: this._manual, fallback: null } : null;
    if (this.strategy === 'local' || this.strategy === 'cloud') {
      const pool = this._pool[this.strategy];
      const primary = pool.find(entry => entry.provider.id === this.active.providerId) || pool[0] || null;
      return primary ? { primary, fallback: null } : null;
    }

    const selected = this._instances.get(this.active.providerId) || null;
    if (selected) {
      if (selected.kind === 'local') {
        const healthy = await this._probeLocal(selected);
        if (!healthy) {
          return { error: '选中的本地模型不可用，请确认本地模型服务（Ollama / LM Studio）已启动，或改选云端模型。' };
        }
        return { primary: selected, fallback: null, disableLocalRetry: true };
      }
      // 用户显式选定的供应商是权威路由：失败时不得悄悄转投未选定的
      // 本地模型，否则云端故障会被本地连接错误掩盖并产生困惑。
      return { primary: selected, fallback: null };
    }

    const preferredKind = prefer === 'cloud' ? 'cloud' : 'local';
    let primary = this._pool[preferredKind][0] || this._pool[preferredKind === 'local' ? 'cloud' : 'local'][0] || null;
    if (!primary) return null;
    if (primary.kind === 'local') {
      const healthy = await this._probeLocal(primary);
      if (!healthy) {
        const cloud = this._pool.cloud[0];
        if (!cloud) return { error: '本地模型健康探针失败，当前没有可用的云端模型。' };
        return { primary: cloud, fallback: null, localUnavailable: true };
      }
    }
    const fallback = primary.kind === 'local' ? this._pool.cloud[0] : this._pool.local[0];
    return { primary, fallback: fallback || null };
  }

  async _probeLocal(entry) {
    const now = Date.now();
    const cached = this._health.get(entry.provider.id);
    if (cached?.promise) return cached.promise;
    if (cached && now - cached.checkedAt < HEALTH_TTL_MS) return cached.healthy;
    const state = { promise: null, checkedAt: now, healthy: false, expiresAt: now + HEALTH_TTL_MS };
    state.promise = Promise.resolve(entry.instance.healthCheck({ timeoutMs: 1000 }))
      .then(healthy => Boolean(healthy))
      .catch(() => false)
      .then(healthy => {
        state.checkedAt = Date.now();
        state.expiresAt = state.checkedAt + HEALTH_TTL_MS;
        state.healthy = healthy;
        state.promise = null;
        return healthy;
      });
    this._health.set(entry.provider.id, state);
    return state.promise;
  }

  async _call(entry, options) {
    this._active = entry;
    debugLog('CALL', JSON.stringify({
      providerId: entry.provider.id,
      kind: entry.kind,
      model: entry.instance?.model || '',
      maxTokens: options.maxTokens || 0,
      temperature: options.temperature ?? '(default)',
      prefer: options.prefer || '',
      hasCloudSystemPrompt: Boolean(options.cloudSystemPrompt),
      messageCount: Array.isArray(options.messages) ? options.messages.length : 0,
      messageLengths: Array.isArray(options.messages)
        ? options.messages.map(message => typeof message.content === 'string' ? message.content.length : -1)
        : [],
    }));
    if (entry.kind !== 'local') return entry.instance.chat(this._request(entry, options));
    const attempts = options.disableLocalRetry ? [0] : [0, 1, 2];
    let lastError;
    for (const attempt of attempts) {
      const previous = entry.lock;
      let release;
      entry.lock = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        const messages = Array.isArray(options.messages) ? options.messages : [];
        const inputBudget = Math.max(4096, Math.floor(entry.contextWindow * (attempt === 0 ? 0.38 : attempt === 1 ? 0.25 : 0.16)));
        const compactMessages = attempt === 0
          ? messages
          : fitMessagesToContext(messages, inputBudget);
        if (attempt > 0) options.onRetry?.(attempt);
        return await entry.instance.chat(this._request(entry, {
          ...options,
          messages: compactMessages,
          maxTokens: attempt === 0 ? options.maxTokens : Math.min(options.maxTokens || 1024, attempt === 1 ? 768 : 512),
          degradationAttempt: attempt,
          signal: options.signal,
        }));
      } catch (error) {
        lastError = error;
        if (attempt === attempts.length - 1 || isCancellationError(error, options.signal)) throw error;
      } finally {
        release();
      }
    }
    throw lastError || new Error('本地模型请求失败');
  }

  getContextWindow(prefer = '') {
    const entry = prefer === 'local'
      ? this._pool.local[0]
      : prefer === 'cloud'
        ? this._pool.cloud[0]
        : this._active || this._pool.local[0] || this._pool.cloud[0];
    return entry?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  }

  getContextProfile(prefer = '') {
    const entry = prefer === 'local'
      ? this._pool.local[0]
      : prefer === 'cloud'
        ? this._pool.cloud[0]
        : this._active || this._instances.get(this.active.providerId) || this._pool.local[0] || this._pool.cloud[0];
    return contextProfileFor({
      kind: entry?.kind || 'cloud',
      contextWindow: entry?.contextWindow || DEFAULT_CONTEXT_WINDOW,
      profile: entry?.provider?.contextProfile || modelConfigFor(entry?.provider || {}, this.active).contextProfile || {},
    });
  }

  get contextWindow() {
    return this.getContextWindow();
  }

  // Whether the model that would actually serve a request (per routing) can
  // accept image content. Callers attach vision images only when this is true;
  // image-only models would otherwise hang or reject on image_url parts.
  async supportsVision({ prefer = '' } = {}) {
    try {
      const route = await this._route(prefer);
      return Boolean(route?.primary?.instance?.supportsVision?.());
    } catch {
      return false;
    }
  }

  _request(entry, options) {
    const localMinimum = options.degradationAttempt === 2
      ? 512
      : options.degradationAttempt === 1
        ? 768
        : MIN_LOCAL_MAX_TOKENS;
    const withBudgets = entry.kind === 'local'
      ? { ...options, maxTokens: Math.min(Math.max(options.maxTokens || 0, localMinimum), MAX_LOCAL_OUTPUT_TOKENS) }
      : options;
    const withPrompt = entry.kind === 'cloud' && options.cloudSystemPrompt
      ? {
          ...withBudgets,
          messages: withBudgets.messages.map((message, index) =>
            index === 0 && message?.role === 'system'
              ? { ...message, content: options.cloudSystemPrompt }
              : message,
          ),
        }
      : withBudgets;
    return entry.ollama
      ? { ...withPrompt, messages: normalizeOllamaMessages(withPrompt.messages) }
      : { ...withPrompt, messages: sanitizeMessages(withPrompt.messages) };
  }

  async chat(options = {}) {
    const allowOverride = options.allowPolicyOverride === true;
    // Policy state belongs to one request. Sharing it lets concurrent cloud
    // calls overwrite each other's review lifecycle.
    const policyRouter = this._createPolicyRouter();
    const route = await this._route(options.prefer);
    if (!route || route.error || !route.primary) {
      if (route?.error) throw new Error(route.error);
      const detail = this.strategy === 'auto'
        ? '未配置可用的语言模型（请在设置中添加本地或云端模型）'
        : this.strategy === 'local'
          ? '未配置本地模型（LM Studio / Ollama），可在设置中添加'
          : '未配置云端模型，可在设置中添加';
      throw new Error(detail);
    }
    const requestOptions = {
      ...options,
      ...(route.disableLocalRetry ? { disableLocalRetry: true } : {}),
      policyCacheKey: policyRequestKey(options, route, this.active, this._allowMediaToCloud),
    };
    if (route.primary.kind === 'cloud') return this._chatCloudOrLocal(route.primary, requestOptions, route, policyRouter);

    try {
      return await this._call(route.primary, requestOptions);
    } catch (error) {
      if (isCancellationError(error, requestOptions.signal) || !route.fallback) throw error;
      const decision = policyRouter.review(requestOptions.messages, {
        forceAllow: allowOverride,
        allowMediaToCloud: this._allowMediaToCloud,
        policyCacheKey: requestOptions.policyCacheKey,
      });
      if (!allowOverride && decision.requiresLocal) {
        policyRouter.block(decision);
        policyRouter.complete();
        throw new CloudPolicyBlockedError('该请求未发送到云端：本地模型不可用，安全路由已停止云端兜底。', { ...decision, localUnavailable: true });
      }
      if (route.fallback.kind !== 'cloud') {
        policyRouter.complete();
        throw new CloudPolicyBlockedError(
          allowOverride ? '该请求无法发送到云端：当前没有可用的云端模型。' : '该请求未发送到云端：本地模型不可用，安全路由已停止云端兜底。',
          { ...decision, localUnavailable: true },
        );
      }
      try {
        return await this._call(route.fallback, requestOptions);
      } catch {
        throw error;
      } finally {
        policyRouter.complete();
      }
    }
  }

  async _chatLocalOrBlock(localEntry, options, decision, policyRouter) {
    const allowOverride = options.allowPolicyOverride === true;
    if (!localEntry) {
      if (allowOverride) {
        const cloud = this._pool.cloud[0];
        if (cloud) {
          try {
            return await this._call(cloud, options);
          } finally {
            policyRouter.complete();
          }
        }
      }
      policyRouter.block(decision);
      policyRouter.complete();
      throw new CloudPolicyBlockedError('该请求未发送到云端：内部审查要求使用本地模型，但当前没有可用的本地模型。', decision);
    }
    try {
      return await this._call(localEntry, options);
    } catch (error) {
      if (isCancellationError(error, options.signal)) throw error;
      if (decision.requiresLocal) {
        if (allowOverride) {
          const cloud = this._pool.cloud[0];
          if (cloud) {
            try {
              return await this._call(cloud, options);
            } finally {
              policyRouter.complete();
            }
          }
        }
        policyRouter.block(decision);
        throw new CloudPolicyBlockedError('该请求未发送到云端：本地模型处理失败，安全路由已停止云端发送。', { ...decision, localUnavailable: true });
      }
      throw error;
    } finally {
      policyRouter.complete();
    }
  }

  async _chatCloudOrLocal(cloudEntry, options, route, policyRouter) {
    const decision = policyRouter.review(options.messages, {
      forceAllow: options.allowPolicyOverride === true,
      allowMediaToCloud: this._allowMediaToCloud,
      policyCacheKey: options.policyCacheKey,
    });
    if (decision.requiresLocal) {
      const localEntry = route.localUnavailable ? null : route.fallback?.kind === 'local' ? route.fallback : this._pool.local[0];
      return this._chatLocalOrBlock(localEntry, options, decision, policyRouter);
    }

    try {
      return await this._call(cloudEntry, options);
    } catch (error) {
      if (isCancellationError(error, options.signal)) throw error;
      const localEntry = route.fallback?.kind === 'local' ? route.fallback : null;
      if (!localEntry || route.localUnavailable) {
        throw error;
      }
      policyRouter.useLocal({ reason: 'cloud_failure' });
      try {
        return await this._call(localEntry, options);
      } finally {
        policyRouter.complete();
      }
    } finally {
      policyRouter.complete();
    }
  }

  cancel() {
    this._active?.instance?.cancel?.();
  }

  get isConfigured() {
    if (this.strategy === 'manual') return Boolean(this._manual);
    if (this.strategy === 'local' || this.strategy === 'cloud') return this._pool[this.strategy].length > 0;
    return this._pool.local.length > 0 || this._pool.cloud.length > 0;
  }
}

function normalizeOllamaMessages(messages = []) {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .filter(part => part?.type === 'text')
      .map(part => part.text || '')
      .join('\n');
    const images = message.content
      .filter(part => part?.type === 'image_url')
      .map(part => String(part.image_url?.url || '').replace(/^data:[^;]+;base64,/, ''))
      .filter(Boolean);
    return { ...message, content: text, ...(images.length > 0 ? { images } : {}) };
  });
}
