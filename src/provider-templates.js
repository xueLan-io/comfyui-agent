export const TEMPLATES = {
  lmstudio: { id: 'lmstudio', name: 'LM Studio', mark: 'LM', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model', name: '本地模型（请替换 ID）' }] },
  ollama: { id: 'ollama', name: 'Ollama', mark: 'OL', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'llama4:scout', name: 'Llama 4 Scout' }, { id: 'qwen3.6:27b', name: 'Qwen 3.6 27B' }] },
  deepseek: { id: 'deepseek', name: 'DeepSeek', mark: 'DS', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
  glm: { id: 'glm', name: 'GLM · 智谱', mark: 'GLM', type: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'glm-5', name: 'GLM-5', vision: true }, { id: 'glm-5-turbo', name: 'GLM-5 Turbo' }] },
  moonshot: { id: 'moonshot', name: 'Kimi · 月之暗面', mark: 'K', type: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', models: [{ id: 'kimi-k3', name: 'Kimi K3' }, { id: 'kimi-k2.6', name: 'Kimi K2.6' }] },
  dashscope: { id: 'dashscope', name: 'Qwen · 通义千问', mark: 'Q', type: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' }, { id: 'qwen3.8-max', name: 'Qwen3.8 Max' }, { id: 'qwen-flash', name: 'Qwen Flash' }] },
  volcengine: { id: 'volcengine', name: '豆包 · 火山引擎', mark: '豆', type: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: [{ id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro' }, { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao Seed 2.0 Lite' }] },
  baidu: { id: 'baidu', name: '文心 · 百度千帆', mark: '文', type: 'openai-compatible', baseUrl: 'https://qianfan.baidubce.com/v2', models: [{ id: 'ernie-5.1', name: 'ERNIE 5.1' }, { id: 'ernie-5.0', name: 'ERNIE 5.0' }] },
  hunyuan: { id: 'hunyuan', name: '混元 · 腾讯云', mark: '混', type: 'openai-compatible', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: [{ id: 'hunyuan-turbos-latest', name: 'Hunyuan TurboS' }] },
  siliconflow: { id: 'siliconflow', name: '硅基流动', mark: '硅', type: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', models: [{ id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' }, { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B-A3B' }, { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' }] },
  minimax: { id: 'minimax', name: 'MiniMax', mark: 'MM', type: 'openai-compatible', baseUrl: 'https://api.minimaxi.com/v1', models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }, { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }] },
  openai: { id: 'openai', name: 'OpenAI', mark: 'O', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5.6', name: 'GPT-5.6', vision: true }, { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vision: true }, { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vision: true }] },
  openaiImage: { id: 'openai-image', name: 'OpenAI Image', mark: 'OI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-image-2', name: 'GPT Image 2', kind: 'image', runtime: 'cloud' }] },
  xai: { id: 'xai', name: 'Grok · xAI', mark: 'G', type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', models: [{ id: 'grok-4.5', name: 'Grok 4.5', vision: true }, { id: 'grok-4.3', name: 'Grok 4.3', vision: true }] },
  gemini: { id: 'gemini', name: 'Gemini · Google', mark: 'Ge', type: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', models: [{ id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', vision: true }] },
  openrouter: { id: 'openrouter', name: 'OpenRouter', mark: 'OR', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'openrouter/auto', name: 'Auto（自动路由）' }] },
};

export const TEMPLATE_GROUPS = [
  { key: 'local', labelKey: 'localModels', ids: ['lmstudio', 'ollama'] },
  { key: 'domestic', labelKey: 'domesticCloudServices', ids: ['deepseek', 'glm', 'moonshot', 'dashscope', 'volcengine', 'baidu', 'hunyuan', 'siliconflow', 'minimax'] },
  { key: 'international', labelKey: 'internationalCloudServices', ids: ['openai', 'openaiImage', 'xai', 'gemini', 'openrouter'] },
];

export const EMPTY_PROVIDER = { id: '', name: '', type: 'openai-compatible', baseUrl: '', apiKey: '', headers: {}, models: [{ id: '', name: '', kind: 'chat' }] };