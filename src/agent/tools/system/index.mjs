import { ComfyUITool } from '../comfyui/index.mjs';

const MODEL_SOURCES = [
  { kind: 'checkpoints', nodes: ['CheckpointLoaderSimple'], input: 'ckpt_name' },
  { kind: 'checkpoints', nodes: ['easy control'], input: 'ckpt_name' },
  { kind: 'loras', nodes: ['LoraLoader', 'LoraLoaderModelOnly'], input: 'lora_name' },
  { kind: 'vae', nodes: ['VAELoader'], input: 'vae_name' },
  { kind: 'controlnets', nodes: ['ControlNetLoader', 'easy controlNetLoader'], input: 'control_net_name' },
  { kind: 'diffusion_models', nodes: ['UNETLoader'], input: 'unet_name' },
  { kind: 'text_encoders', nodes: ['CLIPLoader'], input: 'clip_name' },
  { kind: 'upscale_models', nodes: ['UpscaleModelLoader'], input: 'model_name' },
];

const MODEL_FOLDERS = ['checkpoints', 'diffusion_models', 'loras', 'vae', 'controlnet', 'text_encoders', 'upscale_models'];

const FAMILY_PATTERNS = [
  { family: 'anima', pattern: /anima|miaomiao|anime/i },
  { family: 'flux', pattern: /flux/i },
  { family: 'wan', pattern: /\bwan(?:2|\s|_|-|\.)/i },
  { family: 'animatediff', pattern: /animatediff/i },
  { family: 'sdxl', pattern: /sdxl|xl/i },
  { family: 'controlnet', pattern: /controlnet|control_net/i },
  { family: 'ipadapter', pattern: /ipadapter|ip-adapter/i },
  { family: 'lora', pattern: /\.safetensors$/i },
];

function detectFamily(name) {
  const match = FAMILY_PATTERNS.find(entry => entry.pattern.test(name));
  return match ? match.family : 'generic';
}

function matchesQuery(name, query) {
  if (!query) return true;
  return name.toLowerCase().includes(String(query).toLowerCase());
}

function queueSummary(queue = {}) {
  const running = queue.queue_running || [];
  const pending = queue.queue_pending || [];
  return {
    running: running.length,
    pending: pending.length,
    runningPromptIds: running.map(item => item?.[1]).filter(Boolean),
    pendingPromptIds: pending.map(item => item?.[1]).filter(Boolean),
  };
}

function modelSummary(objectInfo) {
  const byKind = {};
  for (const source of MODEL_SOURCES) {
    const names = new Set();
    for (const nodeType of source.nodes) {
      const def = objectInfo[nodeType];
      const candidates = def?.input?.required?.[source.input] || def?.input?.optional?.[source.input];
      if (Array.isArray(candidates?.[0])) {
        for (const name of candidates[0].slice(0, 200)) names.add(name);
      }
    }
    if (names.size > 0) byKind[source.kind] = [...names].sort();
  }
  return byKind;
}

function deviceSummary(stats = {}) {
  const devices = (stats.devices || [])
    .filter(device => device.name || device.type)
    .map(device => ({
      name: device.name || device.type || 'unknown',
      vramTotal: device.vram_total || 0,
      vramFree: device.vram_free || 0,
    }));
  const system = stats.system || {};
  return {
    devices,
    ramTotal: system.ram_total || 0,
    ramFree: system.ram_free || 0,
  };
}

async function searchModels(client, { query, kind, family }) {
  const folders = kind ? [kind] : MODEL_FOLDERS;
  const collected = [];
  let usedFallback = false;

  if (client.modelList) {
    for (const folder of folders) {
      try {
        const files = await client.modelList(folder);
        for (const entry of files) {
          const file = typeof entry === 'string' ? entry : entry?.name || entry?.file || '';
          if (!file) continue;
          const fileFamily = detectFamily(file);
          if (family && fileFamily !== family) continue;
          if (!matchesQuery(file, query)) continue;
          collected.push({ kind: folder, file, family: fileFamily });
        }
      } catch {}
    }
  }

  if (collected.length === 0) {
    const byKind = modelSummary(await client.objectInfo());
    for (const [folder, files] of Object.entries(byKind)) {
      for (const file of files) {
        const fileFamily = detectFamily(file);
        if (family && fileFamily !== family) continue;
        if (!matchesQuery(file, query)) continue;
        collected.push({ kind: folder, file, family: fileFamily });
      }
    }
    usedFallback = true;
  }

  return { results: collected.slice(0, 100), usedFallback, total: collected.length };
}

function logEntries(history, limit) {
  return Object.values(history || {})
    .slice(0, limit)
    .map(entry => {
      const status = entry.status || {};
      const messages = status.messages || [];
      const error = messages.find(message => message?.[0] === 'execution_error')?.[1];
      const failed = status.completed && status.status_str !== 'success';
      const summary = messages.map(message => message?.[1]?.message).filter(Boolean);
      return {
        promptId: entry.prompt?.[1] || Object.keys(history).find(key => history[key] === entry) || null,
        status: status.status_str || (status.completed ? 'completed' : 'pending'),
        completed: Boolean(status.completed),
        failed,
        outputs: entry.outputs ? Object.keys(entry.outputs).map(String) : [],
        summary: summary.slice(-3),
        error: error
          ? {
              nodeId: error.node_id != null ? String(error.node_id) : null,
              nodeType: error.node_type || null,
              exceptionType: error.exception_type || null,
              exceptionMessage: error.exception_message || null,
              traceback: error.traceback ? error.traceback.slice(-8) : null,
            }
          : null,
      };
    });
}

export const SystemTool = {
  name: 'system',
  description: 'Query local ComfyUI status, queue, models, device memory, and execution logs. It cannot mutate the queue, models, or device state.',
  category: 'management',
  tags: ['system', 'comfyui', 'status', 'models', 'device', 'log'],
  timeout_ms: 15000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      reachable: { type: 'boolean' },
      action: { type: 'string' },
      queue: { type: 'object' },
      models: { type: 'object' },
      device: { type: 'object' },
      results: { type: 'array', items: { type: 'object' } },
      usedFallback: { type: 'boolean' },
      total: { type: 'number' },
      entries: { type: 'array', items: { type: 'object' } },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'models', 'device', 'queue', 'search_models', 'log'],
        description: 'Action to perform',
      },
      query: { type: 'string', description: 'Model name fragment for search_models' },
      kind: { type: 'string', enum: MODEL_FOLDERS, description: 'Model folder to restrict search_models to' },
      family: { type: 'string', description: 'Filter search_models results by inferred family (anima, flux, wan, ...)' },
      limit: { type: 'number', description: 'Max history entries for log (default 5)' },
    },
    required: ['action'],
  },

  async execute(input = {}) {
    const { action } = input;
    const client = ComfyUITool.client;
    try {
      if (action === 'status' || action === 'queue') {
        return { action, reachable: true, queue: queueSummary(await client.queue()) };
      }
      if (action === 'models') {
        return { action, reachable: true, models: modelSummary(await client.objectInfo()) };
      }
      if (action === 'device') {
        return { action, reachable: true, device: deviceSummary(await client.systemStats()) };
      }
      if (action === 'search_models') {
        const search = await searchModels(client, input);
        return { action, reachable: true, ...search };
      }
      if (action === 'log') {
        const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 50);
        const history = await client.historyRecent(limit);
        return { action, reachable: true, limit, entries: logEntries(history, limit) };
      }
      return { action, reachable: true, error: `Unknown action: ${action}` };
    } catch (error) {
      return { action, reachable: false, error: error.message };
    }
  },
};
