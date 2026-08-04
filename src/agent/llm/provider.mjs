import { OpenAICompatibleProvider } from './openai-compatible.mjs';
import { OllamaProvider } from './ollama.mjs';
import { CloudPolicyBlockedError, CloudPolicyRouter } from './cloud-policy-router.mjs';
import { sanitizeMessages } from '../schemas/context-sanitizer.mjs';
import { estimateTokens } from '../optimizer/prompt-guard.mjs';

const STRATEGIES = ['auto', 'local', 'cloud', 'manual'];

const MIN_LOCAL_MAX_TOKENS = 1024;
const DEFAULT_CONTEXT_WINDOW = 32768;
const HEALTH_TTL_MS = 10000;
const CONTEXT_RESERVE_TOKENS = 512;

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
  return [...keptSystems, ...keptConversation];
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
  const hasModel = Array.isArray(provider.models) && provider.models.some(model => model.id);
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
  const model = provider.models?.find(item => item.id === active.modelId) || provider.models?.[0] || {};
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
  if (provider.id === active.providerId) return models.find(item => item.id === active.modelId) || models[0] || {};
  return models[0] || {};
}

function contextWindowFor(provider, active) {
  const model = modelConfigFor(provider, active);
  return Number(model.contextWindow || provider.contextWindow) > 0 ? Number(model.contextWindow || provider.contextWindow) : DEFAULT_CONTEXT_WINDOW;
}

function modelFor(provider, active) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (provider.id === active.providerId) {
    const found = models.find(item => item.id === active.modelId);
    if (found) return found.id;
  }
  return models[0]?.id || '';
}

function createInstance(provider, active) {
  const model = modelFor(provider, active);
  if (provider.type === 'ollama') return new OllamaProvider({ baseUrl: provider.baseUrl, model, contextWindow: contextWindowFor(provider, active) });
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
    modelId: chosen ? (chosen.models?.some(model => model.id === active.modelId) ? active.modelId : chosen.models?.[0]?.id || '') : '',
  };
}

export class LLMProvider {
  constructor(config) {
    this.sourceConfig = config || {};
    this._policyRouter = new CloudPolicyRouter();
    this.rebuild();
  }

  setPolicyStateHandler(handler) {
    this._policyRouter.setStateHandler(handler);
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
        return { primary: selected, fallback: null };
      }
      return { primary: selected, fallback: this._pool.local[0] || null };
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
    const state = { promise: null, checkedAt: now, healthy: false };
    state.promise = Promise.resolve(entry.instance.healthCheck({ timeoutMs: 1000 }))
      .then(healthy => Boolean(healthy))
      .catch(() => false)
      .then(healthy => {
        state.checkedAt = Date.now();
        state.healthy = healthy;
        state.promise = null;
        return healthy;
      });
    this._health.set(entry.provider.id, state);
    return state.promise;
  }

  async _call(entry, options) {
    this._active = entry;
    if (entry.kind !== 'local') return entry.instance.chat(this._request(entry, options));
    const previous = entry.lock;
    let release;
    entry.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await entry.instance.chat(this._request(entry, options));
    } finally {
      release();
    }
  }

  getContextWindow(prefer = '') {
    const entry = prefer === 'local'
      ? this._pool.local[0]
      : prefer === 'cloud'
        ? this._pool.cloud[0]
        : this._active || this._pool.local[0] || this._pool.cloud[0];
    return entry?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  }

  get contextWindow() {
    return this.getContextWindow();
  }

  _request(entry, options) {
    const withBudgets = entry.kind === 'local'
      ? { ...options, maxTokens: Math.max(options.maxTokens || 0, MIN_LOCAL_MAX_TOKENS) }
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
    if (route.primary.kind === 'cloud') return this._chatCloudOrLocal(route.primary, options, route);

    try {
      return await this._call(route.primary, options);
    } catch (error) {
      if (!route.fallback) throw error;
      const decision = this._policyRouter.review(options.messages);
      if (decision.requiresLocal) {
        this._policyRouter.block(decision);
        this._policyRouter.complete();
        throw new CloudPolicyBlockedError('该请求未发送到云端：本地模型不可用，安全路由已停止云端兜底。', { ...decision, localUnavailable: true });
      }
      try {
        return await this._call(route.fallback, options);
      } catch {
        throw error;
      } finally {
        this._policyRouter.complete();
      }
    }
  }

  async _chatLocalOrBlock(localEntry, options, decision) {
    if (!localEntry) {
      this._policyRouter.block(decision);
      this._policyRouter.complete();
      throw new CloudPolicyBlockedError('该请求未发送到云端：内部审查要求使用本地模型，但当前没有可用的本地模型。', decision);
    }
    try {
      return await this._call(localEntry, options);
    } catch (error) {
      if (decision.requiresLocal) {
        this._policyRouter.block(decision);
        throw new CloudPolicyBlockedError('该请求未发送到云端：本地模型处理失败，安全路由已停止云端发送。', { ...decision, localUnavailable: true });
      }
      throw error;
    } finally {
      this._policyRouter.complete();
    }
  }

  async _chatCloudOrLocal(cloudEntry, options, route) {
    const decision = this._policyRouter.review(options.messages);
    if (decision.requiresLocal) {
      const localEntry = route.localUnavailable ? null : route.fallback?.kind === 'local' ? route.fallback : this._pool.local[0];
      return this._chatLocalOrBlock(localEntry, options, decision);
    }

    try {
      return await this._call(cloudEntry, options);
    } catch (error) {
      const localEntry = route.fallback?.kind === 'local' ? route.fallback : this._pool.local[0];
      if (!localEntry || route.localUnavailable) {
        throw error;
      }
      this._policyRouter.useLocal({ reason: 'cloud_failure' });
      try {
        return await this._call(localEntry, options);
      } finally {
        this._policyRouter.complete();
      }
    } finally {
      this._policyRouter.complete();
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
