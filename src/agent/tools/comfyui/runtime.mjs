import { ComfyUITool } from './index.mjs';

const MAX_LIMIT = 100;
const MAX_OUTPUTS = 100;
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);

function client() { return ComfyUITool.client; }
function bounded(value, fallback = 20) { return Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT); }
function ids(items = []) { return items.map(item => item?.[1] || item?.[0]).filter(Boolean).map(String); }
function normalizeQueue(queue = {}) {
  const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
  return { ...queue, queue_running: running, queue_pending: pending, running_ids: ids(running), pending_ids: ids(pending), counts: { running: running.length, pending: pending.length } };
}
function outputRefs(entry, nodeId) {
  return Object.entries(entry?.outputs || {}).flatMap(([id, output]) => {
    if (nodeId !== undefined && String(nodeId) !== String(id)) return [];
    return Object.entries(output || {}).flatMap(([outputType, values]) => Array.isArray(values) ? values.filter(item => item?.filename).map(item => ({ ...item, nodeId: String(id), outputType })) : []);
  });
}
function metadata(ref) { return { filename: ref.filename, subfolder: ref.subfolder || '', type: ref.type || 'output', nodeId: ref.nodeId, outputType: ref.outputType }; }

function readTool(name, description, input_schema, output_schema = { type: 'object' }, execute, category = 'runtime', output_types = []) {
  return { name, description, category, permission: 'read', risk_level: 'none', surfaces: ['agent', 'mcp', 'cli'], tags: ['comfyui', 'runtime', 'read'], timeout_ms: 30000, output_types, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 }, input_schema, output_schema, execute };
}
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };

export const ComfyUIGetQueueTool = readTool('comfyui_get_queue', 'Read and normalize the ComfyUI queue.', emptyInput, { type: 'object' }, async () => normalizeQueue(await client().queue()), 'queue');

export const ComfyUIGetStatusTool = readTool('comfyui_get_status', 'Read queue and system status, preserving partial results when system stats are unavailable.', emptyInput, { type: 'object' }, async () => {
  const queue = await client().queue();
  let system = null; const warnings = [];
  try { system = await client().systemStats(); } catch { warnings.push('system_stats_unavailable'); }
  return { reachable: true, queue: normalizeQueue(queue), system, ...(warnings.length ? { warnings } : {}), checkedAt: new Date().toISOString() };
});

export const ComfyUIGetHistoryTool = readTool('comfyui_get_history', 'Read one ComfyUI history entry or a bounded list of recent entries.', { type: 'object', properties: { promptId: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT } }, additionalProperties: false }, { type: 'object' }, async ({ promptId, limit }) => {
  const entries = promptId ? await client().history(promptId) : await client().historyRecent(bounded(limit));
  return { ...(promptId ? { promptId } : {}), entries, count: Object.keys(entries || {}).length };
});

export const ComfyUIGetObjectInfoTool = readTool('comfyui_get_object_info', 'Read all ComfyUI node definitions or one node type.', { type: 'object', properties: { nodeType: { type: 'string' }, includeHidden: { type: 'boolean' } }, additionalProperties: false }, { type: 'object' }, async ({ nodeType, includeHidden = false }) => {
  const all = await client().objectInfo();
  const selected = nodeType ? (all?.[nodeType] ? { [nodeType]: all[nodeType] } : {}) : { ...(all || {}) };
  if (!includeHidden) for (const [key, definition] of Object.entries(selected)) if (definition?.hidden === true) delete selected[key];
  return { nodes: selected, ...(nodeType !== undefined ? { nodeType, found: Boolean(all?.[nodeType]) } : {}) };
});

export const ComfyUIGetSystemStatsTool = readTool('comfyui_get_system_stats', 'Read raw ComfyUI system statistics with lightweight device and memory summaries.', emptyInput, { type: 'object' }, async () => {
  const raw = await client().systemStats();
  const devices = (raw?.devices || []).map(device => ({ name: device.name || device.type || 'unknown', vramTotal: device.vram_total || 0, vramFree: device.vram_free || 0 }));
  return { raw, devices, memory: { ramTotal: raw?.system?.ram_total || 0, ramFree: raw?.system?.ram_free || 0 }, runtime: { version: raw?.system?.comfyui_version || raw?.system?.version || null, pythonVersion: raw?.system?.python_version || null } };
});

export const ComfyUIGetOutputTool = readTool('comfyui_get_output', 'Read bounded output references for a completed ComfyUI prompt.', { type: 'object', properties: { promptId: { type: 'string' }, nodeId: { type: 'string' }, mode: { type: 'string', enum: ['metadata', 'inspect', 'data_url'] }, limit: { type: 'number', minimum: 1, maximum: MAX_OUTPUTS } }, required: ['promptId'], additionalProperties: false }, { type: 'object' }, async ({ promptId, nodeId, mode = 'metadata', limit }) => {
  const history = await client().history(promptId); const entry = history?.[promptId] || history;
  const refs = outputRefs(entry, nodeId).slice(0, bounded(limit, MAX_OUTPUTS));
  const outputs = [];
  for (const ref of refs) {
    if (mode === 'inspect' && !VIDEO_EXTENSIONS.has(String(ref.filename).split('.').pop().toLowerCase())) outputs.push({ ...metadata(ref), inspection: await client().inspectImage(ref) });
    else if (mode === 'data_url' && !VIDEO_EXTENSIONS.has(String(ref.filename).split('.').pop().toLowerCase())) {
      const dataUrl = await client().imageDataUrl(ref); outputs.push({ ...metadata(ref), dataUrl: dataUrl && dataUrl.length < 8 * 1024 * 1024 ? dataUrl : null, dataUrlLimited: Boolean(dataUrl && dataUrl.length >= 8 * 1024 * 1024) });
    } else outputs.push(metadata(ref));
  }
  return { promptId, mode, outputs, count: outputs.length };
}, 'media', ['image', 'video']);

function confirmationError() { return { error: 'Explicit confirmation is required', code: 'confirmation_required' }; }
function targets(input) { return [...new Set([...(input.promptIds || []), ...(input.promptId ? [input.promptId] : [])].map(String))]; }
function mutationTool(name, description, execute) {
  return { name, description, category: name.includes('cancel') ? 'queue' : 'runtime', permission: 'mutate', risk_level: 'high', surfaces: ['agent', 'mcp', 'cli'], tags: ['comfyui', 'runtime', 'mutation'], side_effects: ['modify_runtime_queue'], requires_confirmation: true, idempotent: false, retry: { mode: 'never' }, input_schema: { type: 'object', properties: { promptId: { type: 'string' }, promptIds: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' }, confirmation: { type: 'boolean' } }, additionalProperties: false }, output_schema: { type: 'object' }, execute };
}

export const ComfyUICancelPromptTool = mutationTool('comfyui_cancel_prompt', 'Delete selected queued prompts and optionally interrupt selected running prompts.', async input => {
  if (input.confirmation !== true) return confirmationError();
  const selected = targets(input); if (selected.length === 0 && input.all !== true) return { error: 'Specify promptId/promptIds or set all:true', code: 'target_required' };
  if (input.all === true) {
    const queue = await client().queue();
    const allIds = [...ids(queue?.queue_running), ...ids(queue?.queue_pending)];
    if (allIds.length > 0) await client().queueDelete(allIds);
    await client().interrupt();
    return { status: 'cancelled', all: true, deletedIds: allIds, interrupted: true };
  }
  await client().queueDelete(selected); const interrupted = [];
  for (const id of selected) { try { await client().interrupt(id); interrupted.push(id); } catch {} }
  return { status: 'cancelled', deletedIds: selected, interrupted };
});

export const ComfyUIInterruptTool = mutationTool('comfyui_interrupt', 'Request ComfyUI to interrupt selected execution, or explicitly all execution.', async input => {
  if (input.confirmation !== true) return confirmationError();
  const selected = targets(input); if (selected.length === 0 && input.all !== true) return { error: 'Specify promptId or set all:true', code: 'target_required' };
  if (input.all === true) { await client().interrupt(); return { status: 'interrupted', all: true }; }
  for (const id of selected) await client().interrupt(id);
  return { status: 'interrupted', promptIds: selected };
});

export const RuntimeReadTools = [ComfyUIGetStatusTool, ComfyUIGetQueueTool, ComfyUIGetHistoryTool, ComfyUIGetObjectInfoTool, ComfyUIGetSystemStatsTool, ComfyUIGetOutputTool];
export const RuntimeMutationTools = [ComfyUICancelPromptTool, ComfyUIInterruptTool];
export const RuntimeTools = [...RuntimeReadTools, ...RuntimeMutationTools];
