import { ComfyUITool } from '../comfyui/index.mjs';
import { estimateGenerationResources } from '../../../runtime/resource-estimator.mjs';

const SOURCES = [
  { kind: 'checkpoint', folder: 'checkpoints', nodes: ['CheckpointLoaderSimple'], input: 'ckpt_name' },
  { kind: 'lora', folder: 'loras', nodes: ['LoraLoader', 'LoraLoaderModelOnly'], input: 'lora_name' },
  { kind: 'vae', folder: 'vae', nodes: ['VAELoader'], input: 'vae_name' },
  { kind: 'controlnet', folder: 'controlnet', nodes: ['ControlNetLoader', 'easy controlNetLoader'], input: 'control_net_name' },
  { kind: 'diffusion_model', folder: 'diffusion_models', nodes: ['UNETLoader'], input: 'unet_name' },
  { kind: 'text_encoder', folder: 'text_encoders', nodes: ['CLIPLoader'], input: 'clip_name' },
  { kind: 'upscale_model', folder: 'upscale_models', nodes: ['UpscaleModelLoader'], input: 'model_name' },
];
const FAMILY_PATTERNS = [['anima', /anima|miaomiao|anime/i], ['flux', /flux/i], ['wan', /\bwan(?:2|\s|_|-|\.)/i], ['animatediff', /animatediff/i], ['sdxl', /sdxl|xl/i], ['controlnet', /controlnet|control_net/i], ['ipadapter', /ipadapter|ip-adapter/i]];
function family(file) { const entry = FAMILY_PATTERNS.find(([, pattern]) => pattern.test(file)); return { family: entry?.[0] || 'generic', familyConfidence: entry ? 0.8 : 0.3, familySource: 'filename_pattern' }; }
function model(item, source, available = true) { const file = typeof item === 'string' ? item : item?.name || item?.file || ''; return { id: `${source.kind}:${file}`, kind: source.kind, file, ...family(file), source: 'comfyui_model_list', available, sizeBytes: null, modifiedAt: null, sha256: null, compatibility: { workflowTypes: [], nodeTypes: source.nodes } }; }

export class ModelService {
  constructor({ client = ComfyUITool.client } = {}) { this.client = client; }
  async list({ kind, family: familyFilter, limit = 100 } = {}) {
    const sources = SOURCES.filter(source => !kind || source.kind === kind || source.folder === kind);
    const results = [];
    for (const source of sources) {
      let files = [];
      try { files = await this.client?.modelList?.(source.folder) || []; } catch {}
      for (const item of files) { const entry = model(item, source); if (!familyFilter || entry.family === familyFilter) results.push(entry); }
    }
    if (results.length === 0) {
      const info = await this.client?.objectInfo?.() || {};
      for (const source of sources) for (const nodeType of source.nodes) {
        const values = info[nodeType]?.input?.required?.[source.input] || info[nodeType]?.input?.optional?.[source.input];
        for (const file of Array.isArray(values?.[0]) ? values[0] : []) { const entry = model(file, source); entry.source = 'comfyui_object_info'; if (!familyFilter || entry.family === familyFilter) results.push(entry); }
      }
    }
    return results.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, Math.max(1, Number(limit) || 100));
  }
  async search(input = {}) { const results = await this.list(input); const query = String(input.query || '').toLowerCase(); return { results: results.filter(item => !query || `${item.file} ${item.family}`.toLowerCase().includes(query)), total: results.length }; }
  async checkExists({ kind, file } = {}) { const results = await this.list({ kind, limit: 1000 }); return { kind, file, exists: results.some(item => item.file === file), model: results.find(item => item.file === file) || null }; }
  async requirements({ workflowName, workflowDir } = {}) { const { WorkflowAdapter } = await import('../comfyui/workflow-adapter.mjs'); const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir); return resolved ? resolved.modelRequirements || [] : []; }
  estimate(input = {}) { const estimate = estimateGenerationResources(input); return { estimated: true, confidence: 'low', ...estimate, warnings: estimate.issues || [], issues: estimate.issues || [], blocking: false, source: 'heuristic' }; }
}
