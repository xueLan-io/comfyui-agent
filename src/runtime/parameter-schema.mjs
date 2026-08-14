const LABELS = {
  seed: '随机种子 Seed', steps: '采样步数 Steps', cfg: '提示词遵循度 CFG', width: '宽度 Width', height: '高度 Height',
  batch: '批量 Batch', batch_size: '批量 Batch', denoise: '重绘幅度 Denoise', sampler: '采样器 Sampler',
  sampler_name: '采样器 Sampler', scheduler: '调度器 Scheduler', ckpt_name: 'Checkpoint 模型',
  lora_name: 'LoRA 模型', control_net_name: 'ControlNet 模型', upscale_model: '放大模型', model_name: '模型',
};

const DESCRIPTIONS = {
  steps: '去噪迭代次数，越高通常越细致，但速度更慢。', cfg: '控制画面遵循提示词的程度。', denoise: '图生图或重绘时控制改动幅度。',
  seed: '相同种子和参数通常会得到相近结果。', width: '建议使用模型支持的尺寸倍数。', height: '建议使用模型支持的尺寸倍数。',
};

function numberBounds(name, value) {
  const key = String(name).toLowerCase();
  if (/steps/.test(key)) return { min: 1, max: 150, step: 1 };
  if (/cfg|guidance/.test(key)) return { min: 0, max: 30, step: 0.1 };
  if (/denoise/.test(key)) return { min: 0, max: 1, step: 0.05 };
  if (/width|height|size/.test(key)) return { min: 64, max: 4096, step: 8 };
  if (/batch/.test(key)) return { min: 1, max: 8, step: 1 };
  if (/seed/.test(key)) return { min: 0, max: 2147483647, step: 1 };
  return { min: typeof value === 'number' ? value - Math.abs(value || 1) * 10 : undefined, max: typeof value === 'number' ? value + Math.abs(value || 1) * 10 : undefined, step: Number.isInteger(value) ? 1 : 0.01 };
}

function fieldType(input = {}) {
  if (Array.isArray(input.options) && input.options.length) return 'select';
  const name = String(input.name || '').toLowerCase();
  if (/ckpt|checkpoint|lora|control.?net|upscale.?model|model/.test(name)) return 'model';
  if (typeof input.value === 'boolean') return 'boolean';
  if (typeof input.value === 'number' || input.type === 'number' || input.type === 'int' || input.type === 'float') return 'number';
  return 'text';
}

export function buildParameterSchema(manifest) {
  manifest = manifest || {};
  const fields = [];
  const seen = new Set();
  const add = (input, source, nodeId = '') => {
    const name = String(input.name || input.key || '').trim();
    if (!name) return;
    const key = `${nodeId}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const type = fieldType(input);
    const bounds = type === 'number' ? numberBounds(name, input.value) : {};
    fields.push({ key: name, nodeId: nodeId || null, source, name, label: LABELS[name] || input.label || name, description: input.description || DESCRIPTIONS[name] || '', type, value: input.value, options: input.options || [], modelKind: type === 'model' ? name : '', ...bounds });
  };
  for (const [key, value] of Object.entries(manifest.commonSettings || {})) add({ name: key, value }, 'common');
  for (const node of manifest.editableNodes || []) for (const input of node.inputs || []) add(input, 'node', String(node.id));
  return fields;
}
