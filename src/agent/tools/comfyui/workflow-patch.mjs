import { ComfyUITool } from './index.mjs';
import { WorkflowAdapter } from './workflow-adapter.mjs';
import { workflowToPrompt } from './prompt-builder.mjs';
import {
  applyWorkflowOverrides,
  extractCommonSettings,
  injectExecutionPrompts,
  injectInputMedia,
} from './node-overrides.mjs';

function clone(value) {
  return structuredClone(value);
}

function toDiffEntries(prompt, baseline, changes) {
  return changes.map(change => ({
    nodeId: change.nodeId,
    nodeType: prompt[change.nodeId]?.class_type || '',
    input: change.input,
    from: baseline[change.nodeId]?.inputs?.[change.input],
    to: change.value,
    action: change.source,
  }));
}

export const WorkflowPatchTool = {
  name: 'workflow_patch',
  description: 'Preview the changes that would be applied to a workflow before execution: settings, node overrides, prompt text, and input media. Returns a pure diff with current and target values. Read-only, no files are modified.',
  category: 'management',
  tags: ['workflow', 'patch', 'preview', 'diff'],
  timeout_ms: 20000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      workflow: { type: 'string' },
      diff: { type: 'array', items: { type: 'object' } },
      ignored: { type: 'array', items: { type: 'object' } },
      compiledSettings: { type: 'object' },
      compiledNodeOverrides: { type: 'array', items: { type: 'object' } },
      ready: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['preview'], description: 'Action to perform' },
      workflow: { type: 'string', description: 'Workflow filename inside the workflow directory' },
      settings: { type: 'object', description: 'Sampling settings such as steps, cfg, denoise, seed, sampler, scheduler, width, height' },
      nodeOverrides: { type: 'object', description: 'Per-node input overrides keyed by node id, e.g. {"3":{"text":"..."}}' },
      positivePrompts: { type: 'array', items: { type: 'string' } },
      negative: { type: 'string' },
      media: { type: 'object', description: 'Media refs: {images:[...], masks:[...], videos:[...]}' },
      workflowDir: { type: 'string', description: 'Trusted workflow directory supplied by the runtime' },
    },
    required: ['action', 'workflow', 'workflowDir'],
  },

  async execute(input) {
    const { workflow, workflowDir, settings = {}, nodeOverrides = {}, positivePrompts, negative, media } = input;
    let resolved;
    try {
      resolved = await WorkflowAdapter.resolve(workflow, workflowDir);
    } catch (error) {
      return { workflow, error: error.message };
    }
    if (!resolved) return { workflow, error: `Workflow not found: ${workflow}` };

    let objectInfo = {};
    if (ComfyUITool.client) {
      objectInfo = await ComfyUITool.client.objectInfo().catch(() => ({}));
    }
    const baseline = workflowToPrompt(resolved.workflow, objectInfo);
    const prompt = clone(baseline);

    const overrides = applyWorkflowOverrides(prompt, settings, nodeOverrides);
    const prompts = injectExecutionPrompts(prompt, { positivePrompts, negative }, resolved.promptProfile);
    const mediaInjected = injectInputMedia(prompt, media || {});

    const applied = [...overrides.applied, ...prompts, ...mediaInjected.applied];
    const ignored = [...overrides.ignored, ...mediaInjected.ignored];

    const diff = toDiffEntries(prompt, baseline, applied).sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true }));
    const compiledSettings = extractCommonSettings(prompt);
    const compiledNodeOverrides = overrides.applied
      .filter(entry => entry.source === 'node')
      .map(entry => ({ nodeId: entry.nodeId, input: entry.input, value: entry.value }));

    return {
      workflow,
      diff,
      ignored,
      compiledSettings,
      compiledNodeOverrides,
      ready: Boolean(
        diff.length > 0
        && (Object.keys(settings).length > 0 || Object.keys(nodeOverrides).length > 0 || positivePrompts?.length || negative || media),
      ),
    };
  },
};
