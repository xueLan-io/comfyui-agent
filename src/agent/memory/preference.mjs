import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import electron from 'electron';

const { safeStorage } = electron;

export const DEFAULTS = {
  llm: {
    providers: [{
      id: 'openai',
      name: 'OpenAI Compatible',
      type: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      headers: {},
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    }],
    active: { providerId: 'openai', modelId: 'gpt-4o', reasoningEffort: 'medium', strategy: 'auto' },
    imageProviderId: '',
    imageModelId: '',
  },
  skills: {
    system: { txt2img: true, img2img: true, character: true, video: true },
    custom: [],
    external: [],
  },
  projects: {},
  research: { baiduApiKey: '' },
  prompt: { mode: 'raw', customTemplate: '' },
  comfyui: { baseUrl: 'http://127.0.0.1:8188' },
  ui: {
    theme: 'system',
    accent: '#339CFF',
    sidebarTranslucent: false,
    contrast: 60,
    pointerCursor: true,
    reducedMotion: false,
    uiFontSize: 14,
    codeFontSize: 12,
    diffMarkers: true,
    panelWidth: 320,
  },
  mcp: { enabled: false, host: '127.0.0.1', port: 3333, token: '' },
};

function encrypt(text) {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(text).toString('base64');
    }
  } catch {}
  return Buffer.from(text).toString('base64');
}

function decrypt(encoded) {
  const encrypted = Buffer.from(encoded, 'base64');
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.decryptString(encrypted), error: '' };
    }
  } catch {
    return { value: '', error: 'Saved API key could not be decrypted. Re-enter it in Settings.' };
  }
  if (encrypted.subarray(0, 3).toString('ascii') === 'v10') {
    return { value: '', error: 'Saved API key could not be decrypted. Re-enter it in Settings.' };
  }
  return { value: encrypted.toString('utf-8'), error: '' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrateLLM(llm = {}) {
  if (Array.isArray(llm.providers)) {
    const providers = llm.providers.map(provider => ({
      ...provider,
      type: provider.type || (provider.id === 'ollama' ? 'ollama' : 'openai-compatible'),
      headers: provider.headers && typeof provider.headers === 'object' ? provider.headers : {},
      models: Array.isArray(provider.models) ? provider.models.map(model => ({
        ...model,
        kind: model.kind || (provider.type === 'openai-image' ? 'image' : 'chat'),
        runtime: model.runtime || (model.kind === 'image' ? 'cloud' : ''),
      })) : [],
    }));
    const first = providers[0] || clone(DEFAULTS.llm.providers[0]);
    return {
      providers: providers.length ? providers : [first],
      active: {
        providerId: llm.active?.providerId || first.id,
        modelId: llm.active?.modelId || first.models?.[0]?.id || '',
        reasoningEffort: ['low', 'medium', 'high'].includes(llm.active?.reasoningEffort)
          ? llm.active.reasoningEffort
          : 'medium',
        strategy: ['auto', 'local', 'cloud', 'manual'].includes(llm.active?.strategy) ? llm.active.strategy : 'auto',
      },
      imageProviderId: llm.imageProviderId || providers.find(provider => provider.type === 'openai-image')?.id || '',
      imageModelId: llm.imageModelId || providers.flatMap(provider => provider.models).find(model => model.kind === 'image')?.id || '',
    };
  }

  const type = llm.provider || 'openai-compatible';
  const id = type === 'ollama' ? 'ollama' : 'openai';
  const modelId = llm.model || (type === 'ollama' ? 'llama3.2' : 'gpt-4o');
  return {
    providers: [{
      id,
      name: type === 'ollama' ? 'Ollama' : 'OpenAI Compatible',
      type,
      baseUrl: llm.baseUrl || '',
      apiKey: llm.apiKey || '',
      headers: {},
      models: [{ id: modelId, name: modelId }],
    }],
    active: { providerId: id, modelId, reasoningEffort: 'medium' },
    imageProviderId: '',
    imageModelId: '',
  };
}

function decryptProviders(llm) {
  for (const provider of llm.providers) {
    if (!provider.apiKey?.startsWith('enc:')) continue;
    const encryptedApiKey = provider.apiKey;
    const result = decrypt(encryptedApiKey.slice(4));
    provider.apiKey = result.value;
    if (result.error) {
      provider.apiKeyError = result.error;
      Object.defineProperty(provider, '_encryptedApiKey', { value: encryptedApiKey, configurable: true });
    }
  }
}

function decryptResearch(research) {
  if (!research.baiduApiKey?.startsWith('enc:')) return;
  const encryptedApiKey = research.baiduApiKey;
  const result = decrypt(encryptedApiKey.slice(4));
  research.baiduApiKey = result.value;
  if (result.error) {
    research.baiduApiKeyError = result.error;
    Object.defineProperty(research, '_encryptedBaiduApiKey', { value: encryptedApiKey, configurable: true });
  }
}

function normalizeMcp(value = {}) {
  const port = Number(value.port);
  return {
    enabled: value.enabled === true,
    host: typeof value.host === 'string' && value.host.trim() ? value.host.trim() : '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3333,
    token: typeof value.token === 'string' ? value.token.trim() : '',
  };
}

export class PreferenceMemory {
  constructor(configPath) {
    this.configPath = configPath;
    this.data = clone(DEFAULTS);
    this._load();
  }

  _load() {
    try {
      if (!existsSync(this.configPath)) return;
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      this.data = {
        ...clone(DEFAULTS),
        ...raw,
        llm: migrateLLM(raw.llm),
        skills: {
          ...clone(DEFAULTS.skills),
          ...(raw.skills || {}),
          system: { ...DEFAULTS.skills.system, ...(raw.skills?.system || {}) },
          custom: Array.isArray(raw.skills?.custom) ? raw.skills.custom : [],
          external: Array.isArray(raw.skills?.external) ? raw.skills.external : [],
        },
        projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {},
        research: { ...clone(DEFAULTS.research), ...(raw.research || {}) },
        mcp: normalizeMcp(raw.mcp),
      };
      decryptProviders(this.data.llm);
      decryptResearch(this.data.research);
    } catch {}
  }

  _save() {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      const toStore = clone(this.data);
      for (let index = 0; index < toStore.llm.providers.length; index++) {
        const provider = toStore.llm.providers[index];
        const source = this.data.llm.providers[index];
        delete provider.apiKeyError;
        if (!provider.apiKey && source?._encryptedApiKey) {
          provider.apiKey = source._encryptedApiKey;
          continue;
        }
        if (provider.apiKey && !provider.apiKey.startsWith('enc:')) {
          provider.apiKey = `enc:${encrypt(provider.apiKey)}`;
        }
      }
      delete toStore.research.baiduApiKeyError;
      if (!toStore.research.baiduApiKey && this.data.research._encryptedBaiduApiKey) {
        toStore.research.baiduApiKey = this.data.research._encryptedBaiduApiKey;
      } else if (toStore.research.baiduApiKey && !toStore.research.baiduApiKey.startsWith('enc:')) {
        toStore.research.baiduApiKey = `enc:${encrypt(toStore.research.baiduApiKey)}`;
      }
      const temporaryPath = `${this.configPath}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, JSON.stringify(toStore, null, 2), { mode: 0o600 });
      renameSync(temporaryPath, this.configPath);
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  }

  get(keyPath) {
    const keys = keyPath.split('.');
    let value = this.data;
    for (const key of keys) {
      if (value == null) return undefined;
      value = value[key];
    }
    return value;
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    let target = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) target[keys[i]] = {};
      target = target[keys[i]];
    }
    target[keys.at(-1)] = value;
    this._save();
  }

  getAll() {
    return clone(this.data);
  }
}
