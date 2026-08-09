import { createHash } from 'node:crypto';

const LIMITS = {
  seed: [0, 0xFFFFFFFF], steps: [1, 1000], cfg: [0, 100], denoise: [0, 1],
  width: [1, 16384], height: [1, 16384], batch: [1, 64],
  frames: [1, 4096], fps: [1, 240],
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function number(value, name) {
  const result = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error(`Invalid ${name}: expected a finite number`);
  if (['seed', 'steps', 'width', 'height', 'batch', 'frames', 'fps'].includes(name) && !Number.isInteger(result)) throw new Error(`Invalid ${name}: expected an integer`);
  const [min, max] = LIMITS[name] || [-Infinity, Infinity];
  if (result < min || result > max) throw new Error(`Invalid ${name}: must be between ${min} and ${max}`);
  return result;
}

function mediaList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map(item => {
    if (typeof item === 'string') return { path: item, name: item.split(/[\\/]/).pop() };
    if (!item || typeof item !== 'object') throw new Error(`Invalid ${name} entry`);
    if (typeof item.path === 'string' && item.path) return { path: item.path, name: String(item.name || item.path.split(/[\\/]/).pop()) };
    // Keep legacy ComfyUI references accepted by workflow_patch while the
    // public runtime request still prefers local { path, name } entries.
    if (typeof item.name === 'string' && item.name) return { name: item.name, subfolder: String(item.subfolder || ''), type: String(item.type || 'input') };
    throw new Error(`Invalid ${name} entry`);
  });
}

export function normalizeRuntimeParameters(input = {}) {
  if (input.settings !== undefined && (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings))) throw new Error('settings must be an object');
  const settings = { ...(input.settings || {}) };
  // Video callers historically supplied these at the request root. Canonicalize
  // them into settings so preview, confirmation, and execution use one shape.
  if (settings.frames === undefined && input.frames !== undefined) settings.frames = input.frames;
  if (settings.fps === undefined && input.fps !== undefined) settings.fps = input.fps;
  const normalizedSettings = {};
  for (const name of ['seed', 'steps', 'cfg', 'denoise', 'width', 'height', 'batch', 'frames', 'fps']) {
    if (settings[name] !== undefined && settings[name] !== null && settings[name] !== '') normalizedSettings[name] = number(settings[name], name);
  }
  for (const name of ['sampler', 'scheduler']) if (settings[name] !== undefined) {
    if (typeof settings[name] !== 'string' || !settings[name].trim()) throw new Error(`Invalid ${name}: expected a non-empty string`);
    normalizedSettings[name] = settings[name].trim();
  }
  if (normalizedSettings.denoise === undefined) normalizedSettings.denoise = 1;
  if (normalizedSettings.batch === undefined) normalizedSettings.batch = 1;
  const nodeOverrides = input.nodeOverrides || {};
  if (!nodeOverrides || typeof nodeOverrides !== 'object' || Array.isArray(nodeOverrides)) throw new Error('nodeOverrides must be an object');
  for (const [nodeId, values] of Object.entries(nodeOverrides)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid nodeOverrides entry: ${nodeId}`);
    for (const [name, value] of Object.entries(values)) if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Invalid node override value: ${nodeId}.${name}`);
  }
  const positivePrompts = Array.isArray(input.prompts) ? input.prompts : Array.isArray(input.positivePrompts) ? input.positivePrompts : input.prompt !== undefined ? [input.prompt] : [];
  if (positivePrompts.some(value => typeof value !== 'string')) throw new Error('prompts must contain strings');
  return {
    workflow: { name: String(input.workflowName || input.workflow?.name || ''), dir: String(input.workflowDir || input.workflow?.dir || ''), ...(input.workflow?.revision ? { revision: input.workflow.revision } : {}) },
    prompt: { positive: String(positivePrompts[0] || ''), positivePrompts: clone(positivePrompts), negative: String(input.negativePrompt ?? input.negative ?? '') },
    settings: normalizedSettings,
    nodeOverrides: clone(nodeOverrides),
    media: { images: mediaList(input.images ?? input.media?.images, 'images'), masks: mediaList(input.masks ?? input.media?.masks, 'masks'), videos: mediaList(input.videos ?? input.media?.videos, 'videos') },
    outputNodeIds: input.outputNodeIds === undefined ? [] : (Array.isArray(input.outputNodeIds) ? input.outputNodeIds.map(String) : (() => { throw new Error('outputNodeIds must be an array'); })()),
    source: 'runtime_parameters', mode: 'runtime',
  };
}

export function freezeRuntimeRequest(request) { return clone(request); }

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function runtimeRequestDigest(request) { return `sha256:${createHash('sha256').update(stable(request)).digest('hex')}`; }

export function createRuntimeDiff(before, after) {
  const diff = [];
  for (const [nodeId, node] of Object.entries(after || {})) {
    const oldNode = before?.[nodeId] || {};
    for (const [input, value] of Object.entries(node.inputs || {})) if (JSON.stringify(oldNode.inputs?.[input]) !== JSON.stringify(value)) diff.push({ kind: 'node_input', nodeId: String(nodeId), input, from: oldNode.inputs?.[input], to: clone(value) });
  }
  for (const nodeId of Object.keys(before || {})) if (!after?.[nodeId]) diff.push({ kind: 'output', nodeId: String(nodeId), from: 'present', to: 'removed' });
  return diff;
}

export { LIMITS };
