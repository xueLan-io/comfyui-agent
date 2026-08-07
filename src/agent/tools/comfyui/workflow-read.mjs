import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ComfyUITool, workflowManifestCache } from './index.mjs';
import { resolveWorkflowPath } from './workflow-adapter.mjs';
import { WorkflowInspectTool } from './workflow-inspect.mjs';
import { findNodeGroup, describeInput, getInputDefinition, workflowToPrompt } from './prompt-builder.mjs';
import { isEditableValue } from './node-overrides.mjs';

const MAX_LIMIT = 200;
const objectInfoCache = { value: null, expiresAt: 0 };

async function objectInfo(refresh = false) {
  const now = Date.now();
  if (!refresh && objectInfoCache.value && objectInfoCache.expiresAt > now) return objectInfoCache.value;
  objectInfoCache.value = await ComfyUITool.client.objectInfo();
  objectInfoCache.expiresAt = now + 3000;
  return objectInfoCache.value;
}

function limit(value, fallback = 50) {
  return Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT);
}

function sourceNode(resolved, id) {
  return (resolved.workflow.nodes || []).find(node => String(node.id) === String(id));
}

function nodeTitle(node, definition = {}) {
  return node?.title || definition.display_name || node?.type || '';
}

function formatNode(resolved, prompt, objectInfoValue, id, includeInputs = true) {
  const promptNode = prompt[String(id)];
  const source = sourceNode(resolved, id);
  const definition = objectInfoValue[promptNode?.class_type] || {};
  const inputs = includeInputs
    ? Object.entries(promptNode?.inputs || {}).map(([name, value]) => ({
      name,
      value: Array.isArray(value) ? { linked: `${prompt[String(value[0])]?.class_type || ''} #${value[0]}`, output: value[1] } : value,
      editable: isEditableValue(value),
      type: describeInput(name, value, getInputDefinition(definition, name)).type,
    }))
    : undefined;
  return {
    id: String(id), type: promptNode?.class_type || source?.type, title: nodeTitle(source, definition),
    group: findNodeGroup(source || {}, resolved.workflow.groups), active: source?.mode !== 4,
    ...(includeInputs ? { inputs } : {}),
  };
}

async function resolve(name, dir, refresh = false) {
  return workflowManifestCache.get(name, dir, { refresh });
}

function baseReadSchema() {
  return { type: 'object', properties: { workflowName: { type: 'string' }, workflowDir: { type: 'string' } }, required: ['workflowName', 'workflowDir'], additionalProperties: false };
}

function tool(name, description, properties, execute, output_schema = { type: 'object' }) {
  return { name, description, category: 'workflow', permission: 'read', risk_level: 'none', surfaces: ['agent', 'mcp', 'cli'], tags: ['workflow', 'read'], side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 }, input_schema: { ...baseReadSchema(), properties: { ...baseReadSchema().properties, ...properties } }, output_schema, execute };
}

export const WorkflowListTool = tool('workflow_list', 'List readable JSON ComfyUI workflows.', { search: { type: 'string' }, modelType: { type: 'string' }, capability: { type: 'string' }, limit: { type: 'number' } }, async ({ workflowDir, search, modelType, capability, limit: max }) => {
  const items = await ComfyUITool.discover(workflowDir);
  return { workflows: items.filter(item => (!search || item.name.toLowerCase().includes(search.toLowerCase())) && (!modelType || item.modelType === modelType) && (!capability || item.capabilities?.modes?.includes(capability))).slice(0, limit(max, 100)) };
});

export const WorkflowReadTool = tool('workflow_read', 'Read a workflow JSON file inside the configured workflow directory.', { format: { type: 'string', enum: ['raw', 'normalized'] } }, async ({ workflowName, workflowDir, format = 'raw' }) => {
  const filePath = resolveWorkflowPath(workflowDir, workflowName);
  if (!existsSync(filePath)) return { workflowName, error: `Workflow not found: ${workflowName}` };
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  return format === 'normalized' ? { workflowName, ...await resolve(workflowName, workflowDir) } : { workflowName, workflow: raw };
});

export const WorkflowSnapshotTool = tool('workflow_snapshot', 'Return a stable workflow graph snapshot.', { refresh: { type: 'boolean' } }, async ({ workflowName, workflowDir, refresh }) => ComfyUITool.inspectWorkflow(workflowName, workflowDir, { refresh: Boolean(refresh) }));

export const WorkflowListNodesTool = tool('workflow_list_nodes', 'List active and inactive workflow nodes.', { activeOnly: { type: 'boolean' }, includeInputs: { type: 'boolean' }, limit: { type: 'number' } }, async ({ workflowName, workflowDir, activeOnly = false, includeInputs = true, limit: max }) => {
  const resolved = await resolve(workflowName, workflowDir);
  const info = await objectInfo();
  const prompt = workflowToPrompt(resolved.workflow, info);
  const ids = (resolved.workflow.nodes || []).filter(node => !activeOnly || node.mode !== 4).map(node => String(node.id));
  const nodes = ids.slice(0, limit(max)).map(id => formatNode(resolved, prompt, info, id, includeInputs));
  return { nodes, count: nodes.length };
});

export const WorkflowGetNodeTool = tool('workflow_get_node', 'Read one workflow node.', { nodeId: { type: 'string' }, includeInputs: { type: 'boolean' } }, async ({ workflowName, workflowDir, nodeId, includeInputs = true }) => {
  const resolved = await resolve(workflowName, workflowDir); const info = await objectInfo(); const prompt = workflowToPrompt(resolved.workflow, info);
  if (!sourceNode(resolved, nodeId)) return { workflowName, error: `Node #${nodeId} not found` };
  return { workflowName, node: formatNode(resolved, prompt, info, nodeId, includeInputs) };
});

export const WorkflowFindNodesTool = tool('workflow_find_nodes', 'Find workflow nodes using literal type, input, and value matching.', { type: { type: 'string' }, input: { type: 'string' }, value: { type: 'string' }, limit: { type: 'number' } }, async ({ workflowName, workflowDir, type, input, value, limit: max }) => {
  const resolved = await resolve(workflowName, workflowDir); const info = await objectInfo(); const prompt = workflowToPrompt(resolved.workflow, info); const matches = [];
  for (const id of Object.keys(prompt)) {
    const node = prompt[id]; const fields = Object.entries(node.inputs || {}).filter(([, v]) => isEditableValue(v));
    if (type && !String(node.class_type).toLowerCase().includes(type.toLowerCase())) continue;
    if (input && !Object.prototype.hasOwnProperty.call(node.inputs || {}, input)) continue;
    const matched = value === undefined ? [] : fields.filter(([, v]) => String(v).toLowerCase().includes(String(value).toLowerCase())).map(([name, v]) => ({ input: name, value: v }));
    if (value !== undefined && matched.length === 0) continue;
    matches.push({ ...formatNode(resolved, prompt, info, id, false), matches: matched }); if (matches.length >= limit(max)) break;
  }
  return { workflowName, nodes: matches, count: matches.length };
});

export const WorkflowListOutputsTool = tool('workflow_list_outputs', 'List ComfyUI output nodes and their media type.', { outputType: { type: 'string', enum: ['image', 'video', 'all'] } }, async ({ workflowName, workflowDir, outputType = 'all' }) => {
  const resolved = await resolve(workflowName, workflowDir); const info = await objectInfo(); const prompt = workflowToPrompt(resolved.workflow, info);
  const outputs = Object.keys(prompt).flatMap(id => { const node = prompt[id]; const def = info[node.class_type] || {}; if (def.output_node !== true) return []; const video = /video|animated|webp|gif/i.test(node.class_type); const type = video ? 'video' : 'image'; return outputType !== 'all' && outputType !== type ? [] : [{ ...formatNode(resolved, prompt, info, id, false), outputType: type }]; });
  return { outputs };
});

export const WorkflowValidateTool = tool('workflow_validate', 'Deeply validate workflow structure, links, models, media, and runtime diagnostics.', {}, async ({ workflowName, workflowDir }) => {
  const result = await WorkflowInspectTool.execute({ action: 'validate', workflowName, workflowDir });
  return { valid: result.valid, errors: (result.issues || []).filter(item => item.severity === 'error'), warnings: (result.issues || []).filter(item => item.severity === 'warning'), links: result.issues || [], models: result.modelRequirements || [], media: result.issues?.filter(item => /media/.test(item.code || '')) || [], runtime: result.runtime || null, outputs: result.outputNodes || [], prompt: result.sampler ? { sampler: result.sampler } : null, ...result };
});

export const WorkflowReadTools = [WorkflowListTool, WorkflowReadTool, WorkflowSnapshotTool, WorkflowListNodesTool, WorkflowGetNodeTool, WorkflowFindNodesTool, WorkflowListOutputsTool, WorkflowValidateTool];
