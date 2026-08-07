import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ComfyUITool } from './index.mjs';
import { WorkflowAdapter, resolveWorkflowPath } from './workflow-adapter.mjs';
import { workflowToPrompt } from './prompt-builder.mjs';
import { applyWorkflowOverrides, extractCommonSettings, injectExecutionPrompts, injectInputMedia, selectExecutionOutputs, selectPreferredExecutionOutputs } from './node-overrides.mjs';
import { normalizeRuntimeParameters, freezeRuntimeRequest, runtimeRequestDigest, createRuntimeDiff } from '../../../runtime/runtime-parameters-contract.mjs';

function fileRevision(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

export async function compileRuntimeParameters({ workflow, objectInfo = {}, request }) {
  const sourceWorkflow = workflow.workflow || workflow;
  const adaptedWorkflow = workflow.adapter?.prepare(structuredClone(sourceWorkflow), request) || structuredClone(sourceWorkflow);
  const baseline = structuredClone(workflowToPrompt(sourceWorkflow, objectInfo));
  const prompt = structuredClone(workflowToPrompt(adaptedWorkflow, objectInfo));
  const overrides = applyWorkflowOverrides(prompt, request.settings, request.nodeOverrides);
  const prompts = injectExecutionPrompts(prompt, request.prompt, workflow.promptProfile || {});
  const media = injectInputMedia(prompt, request.media);
  const knownOutputIds = Object.entries(prompt).filter(([, node]) => objectInfo[node.class_type]?.output_node === true).map(([id]) => id);
  const selected = request.outputNodeIds.length > 0 ? request.outputNodeIds.filter(id => knownOutputIds.includes(String(id))) : selectPreferredExecutionOutputs(prompt, knownOutputIds);
  const unknownOutputs = request.outputNodeIds.filter(id => !knownOutputIds.includes(String(id))).map(id => ({ kind: 'output', nodeId: String(id), reason: 'output_not_found', source: 'outputNodeIds' }));
  const removed = selected.length > 0 ? selectExecutionOutputs(prompt, selected, knownOutputIds) : [];
  const overrideByKey = new Map(overrides.applied.map(entry => [`${entry.nodeId}:${entry.input}`, entry]));
  const diff = createRuntimeDiff(baseline, prompt).map(entry => {
    const override = overrideByKey.get(`${entry.nodeId}:${entry.input}`);
    return override
      ? { ...entry, kind: override.source === 'node' ? 'node_input' : 'setting', source: override.source }
      : { ...entry, source: entry.kind === 'node_input' ? 'runtime' : 'output' };
  });
  for (const entry of prompts) diff.push({ kind: 'prompt', nodeId: entry.nodeId, input: entry.input, target: entry.polarity, from: baseline[entry.nodeId]?.inputs?.[entry.input], to: entry.value, source: `prompt_${entry.polarity}` });
  for (const entry of media.applied) diff.push({ kind: 'media', nodeId: entry.nodeId, input: entry.input, to: entry.value, source: entry.source });
  for (const nodeId of removed) diff.push({ kind: 'output', nodeId, from: 'selected', to: 'removed', source: 'outputNodeIds' });
  const ignored = [...overrides.ignored, ...media.ignored, ...unknownOutputs];
  const errors = ignored.filter(item => item.source === 'node' || item.reason === 'output_not_found' || item.kind === 'images' || item.kind === 'masks' || item.kind === 'videos');
  const frozenRequest = freezeRuntimeRequest({ ...request, workflow: { ...request.workflow, revision: request.workflow.revision || '' } });
  return { prompt, baseline, diff, applied: [...overrides.applied, ...prompts, ...media.applied], ignored, compiledSettings: extractCommonSettings(prompt), compiledNodeOverrides: overrides.applied.filter(item => item.source === 'node'), outputSelection: { requested: request.outputNodeIds, selected, removed }, mediaPatch: { images: media.applied.filter(item => item.source === 'images'), masks: media.applied.filter(item => item.source === 'masks'), videos: media.applied.filter(item => item.source === 'videos') }, preflight: { valid: errors.length === 0, errors, warnings: ignored.filter(item => !errors.includes(item)) }, frozenRequest, requestDigest: runtimeRequestDigest(frozenRequest) };
}

export const ComfyUIRuntimeParametersTool = {
  name: 'comfyui_runtime_parameters', description: 'Preview runtime-only changes for a ComfyUI workflow without writing files, uploading media, or queueing a task.', category: 'generation', tags: ['comfyui', 'generation', 'runtime', 'preview'], permission: 'read', risk_level: 'none', scope: 'session', supports_preview: true, supports_rollback: false, surfaces: ['agent', 'mcp', 'cli'], side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 }, output_types: ['patch', 'validation', 'artifact'],
  input_schema: { type: 'object', properties: { workflowName: { type: 'string' }, workflowDir: { type: 'string' }, prompt: { type: 'string' }, prompts: { type: 'array', items: { type: 'string' } }, negativePrompt: { type: 'string' }, settings: { type: 'object' }, nodeOverrides: { type: 'object' }, images: { type: 'array' }, masks: { type: 'array' }, videos: { type: 'array' }, outputNodeIds: { type: 'array', items: { type: 'string' } }, refresh: { type: 'boolean' } }, required: ['workflowName', 'workflowDir'], additionalProperties: false },
  output_schema: { type: 'object' },
  async execute(input) {
    const path = resolveWorkflowPath(input.workflowDir, input.workflowName);
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ready: false, error: `Workflow not found: ${input.workflowName}` };
      throw error;
    }
    const request = normalizeRuntimeParameters(input); request.workflow.revision = fileRevision(raw);
    const workflow = await WorkflowAdapter.resolve(input.workflowName, input.workflowDir); if (!workflow) return { ready: false, error: `Workflow not found: ${input.workflowName}` };
    const objectInfo = await ComfyUITool.client.objectInfo().catch(() => ({}));
    const compiled = await compileRuntimeParameters({ workflow, objectInfo, request });
    const previewId = `runtime_preview_${randomUUID()}`;
    return { ready: compiled.preflight.valid, previewId, revision: request.workflow.revision, requestDigest: compiled.requestDigest, workflow: request.workflow, normalizedRequest: request, frozenRequest: compiled.frozenRequest, diff: compiled.diff, applied: compiled.applied, ignored: compiled.ignored, outputSelection: compiled.outputSelection, mediaPatch: compiled.mediaPatch, preflight: compiled.preflight, confirmation: { required: true, actions: ['queue_generation', ...(compiled.mediaPatch.images.length || compiled.mediaPatch.masks.length || compiled.mediaPatch.videos.length ? ['upload_reference_media'] : []), ...(compiled.diff.some(item => item.kind === 'setting' || item.kind === 'node_input') ? ['modify_runtime_node_parameters'] : [])] } };
  },
};
