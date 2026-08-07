import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveWorkflowPath, WorkflowAdapter } from './workflow-adapter.mjs';
import { workflowToPrompt, getInputDefinition } from './prompt-builder.mjs';
import { workflowDiff } from './workflow-diff.mjs';
import { atomicReplace, bufferHash } from '../filesystem/atomic-write.mjs';

const EDITABLE_PROPERTIES = new Set(['title', 'mode']);
const SUPPORTED = new Set(['set_input', 'set_widget', 'set_property']);

function clone(value) { return structuredClone(value); }
function hash(value) { return bufferHash(Buffer.from(value, 'utf8')); }
function formatOf(value) { return Array.isArray(value?.nodes) && Array.isArray(value?.links) ? 'ui' : Object.values(value || {}).every(node => node?.class_type && node?.inputs) ? 'api' : 'unknown'; }
function inputConfig(info, nodeType, input) {
  return getInputDefinition(info?.[nodeType] || {}, input);
}
function widgetIndex(node, input, objectInfo) {
  const definition = inputConfig(objectInfo, node.type, input);
  const order = [...(objectInfo?.[node.type]?.input_order?.required || []), ...(objectInfo?.[node.type]?.input_order?.optional || [])];
  let index = 0;
  for (const name of order) {
    const config = inputConfig(objectInfo, node.type, name);
    if (name === input) return index;
    if (config && ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(config[0])) {
      index++;
      if (config[1]?.control_after_generate) index++;
    }
  }
  return definition ? -1 : null;
}
function widgetDefinition(node, index, objectInfo) {
  const order = [...(objectInfo?.[node.type]?.input_order?.required || []), ...(objectInfo?.[node.type]?.input_order?.optional || [])];
  let cursor = 0;
  for (const name of order) {
    const config = inputConfig(objectInfo, node.type, name);
    if (config && ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(config[0])) {
      if (cursor === index) return { name, config };
      cursor++;
      if (config[1]?.control_after_generate) cursor++;
    }
  }
  return null;
}
function validateValue(value, config) {
  if (!config) return 'input definition is unavailable';
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'object' && value !== null && !Array.isArray(value))) return 'value must be a finite scalar';
  const type = config[0]; const props = config[1] || {};
  if (Array.isArray(type) && !type.includes(value)) return 'value is not in the allowed enum';
  if (type === 'INT' && (!Number.isInteger(value))) return 'value must be an integer';
  if (type === 'FLOAT' && typeof value !== 'number') return 'value must be a number';
  if (type === 'BOOLEAN' && typeof value !== 'boolean') return 'value must be boolean';
  if (type === 'STRING' && typeof value !== 'string') return 'value must be a string';
  if (typeof value === 'number' && props.min !== undefined && value < props.min) return 'value is below minimum';
  if (typeof value === 'number' && props.max !== undefined && value > props.max) return 'value exceeds maximum';
  return null;
}
function validateOutputs(workflow) {
  const active = (workflow.nodes || []).filter(node => node.mode !== 4);
  return active.some(node => /saveimage|savevideo|videosave|previewimage|output/i.test(node.type || ''))
    ? null : 'workflow must retain at least one active output node';
}
function validateStructure(workflow) {
  const ids = new Set((workflow.nodes || []).map(node => String(node.id)));
  const issues = [];
  for (const link of workflow.links || []) {
    if (!ids.has(String(link[1])) || !ids.has(String(link[3]))) issues.push({ code: 'broken_link', message: `link ${link[0]} references a missing node` });
  }
  return issues;
}
function applyOperation(workflow, operation, objectInfo) {
  if (!SUPPORTED.has(operation?.op)) throw Object.assign(new Error(`Unsupported operation: ${operation?.op}`), { code: 'UNSUPPORTED_OPERATION' });
  const node = (workflow.nodes || []).find(item => String(item.id) === String(operation.nodeId));
  if (!node) throw new Error(`Node #${operation.nodeId} does not exist`);
  if (node.mode === 4 && operation.op !== 'set_property') throw new Error(`Node #${operation.nodeId} is inactive`);
  if (operation.op === 'set_property') {
    if (!EDITABLE_PROPERTIES.has(operation.path)) throw new Error(`Property is not editable: ${operation.path}`);
    if (operation.path === 'mode' && ![0, 4].includes(operation.value)) throw new Error('mode must be 0 or 4');
    operation.from = clone(node[operation.path]); node[operation.path] = clone(operation.value); return;
  }
  if (operation.op === 'set_widget') {
    if (!Number.isInteger(operation.index) || !Array.isArray(node.widgets_values) || operation.index < 0 || operation.index >= node.widgets_values.length) throw new Error(`Widget index is invalid: ${operation.index}`);
    const widget = widgetDefinition(node, operation.index, objectInfo);
    if (!widget) throw new Error(`Widget index cannot be mapped to a UI input: ${operation.index}`);
    const issue = validateValue(operation.value, widget.config);
    if (issue) throw new Error(`${widget.name}: ${issue}`);
    operation.from = clone(node.widgets_values[operation.index]); node.widgets_values[operation.index] = clone(operation.value); return;
  }
  const input = (node.inputs || []).find(item => item.name === operation.input);
  if (!input) throw new Error(`Input does not exist: ${operation.input}`);
  if (input.link !== undefined && input.link !== null && input.link >= 0) throw new Error(`Input is linked: ${operation.input}`);
  const config = inputConfig(objectInfo, node.type, operation.input);
  const issue = validateValue(operation.value, config);
  if (issue) throw new Error(`${operation.input}: ${issue}`);
  const index = widgetIndex(node, operation.input, objectInfo);
  if (index === null || index < 0 || !Array.isArray(node.widgets_values) || index >= node.widgets_values.length) throw new Error(`Input cannot be mapped to a UI widget: ${operation.input}`);
  operation.from = clone(node.widgets_values[index]); node.widgets_values[index] = clone(operation.value);
}

export class WorkflowMutationService {
  constructor({ revisionStore, objectInfoProvider, validate, invalidateManifest } = {}) { this.revisionStore = revisionStore; this.objectInfoProvider = objectInfoProvider; this.validate = validate; this.invalidateManifest = invalidateManifest; }
  async load(input) {
    const workflowPath = resolveWorkflowPath(input.workflowDir, input.workflowName);
    if (!existsSync(workflowPath)) throw new Error(`Workflow not found: ${input.workflowName}`);
    const content = readFileSync(workflowPath, 'utf8');
    return { workflowPath, content, workflow: JSON.parse(content), format: formatOf(JSON.parse(content)), beforeHash: hash(content) };
  }
  async preview(input) {
    const current = await this.load(input);
    if (current.format !== 'ui') return { ready: false, code: 'WORKFLOW_FORMAT_UNSUPPORTED', format: current.format };
    const objectInfo = await (this.objectInfoProvider?.() || {});
    const workflow = clone(current.workflow); const operations = clone(input.operations || []);
    for (const operation of operations) applyOperation(workflow, operation, objectInfo);
    const diff = workflowDiff(operations, current.workflow);
    if (diff.length === 0) return { ready: false, workflowName: input.workflowName, format: 'ui', baseRevision: { sha256: current.beforeHash }, diff: [], warnings: ['no_changes'] };
    const frozenContent = `${JSON.stringify(workflow, null, 2)}\n`;
    const validation = await (this.validate?.(workflow, input) || { valid: true, errors: [], warnings: [], affectedOutputs: [], modelRequirements: [], linkErrors: [] });
    const structuralIssues = validateStructure(workflow);
    if (structuralIssues.length > 0) {
      validation.errors = [...(validation.errors || []), ...structuralIssues];
      validation.valid = false;
    }
    const outputIssue = validateOutputs(workflow);
    if (outputIssue) {
      validation.errors = [...(validation.errors || []), { code: 'output_missing', message: outputIssue }];
      validation.valid = false;
    }
    return { ready: validation.valid !== false, previewId: `mutation_preview_${createHash('sha1').update(`${current.beforeHash}:${frozenContent}`).digest('hex').slice(0, 16)}`, workflowName: input.workflowName, workflowDir: input.workflowDir, format: 'ui', baseRevision: { sha256: current.beforeHash }, nextRevision: { sha256: hash(frozenContent) }, operations, diff, ignored: [], validation, confirmation: { required: true, actions: ['workflow_write'] }, frozenContent };
  }
  async commit(input, preview) {
    if (input.confirmation !== true) return { code: 'CONFIRMATION_REQUIRED', error: 'Workflow mutation commit requires confirmation' };
    const current = await this.load(input); const expected = input.expectedHash || input.baseRevision || preview?.baseRevision?.sha256;
    if (!preview || preview.frozenContent === undefined) return { code: 'PREVIEW_REQUIRED', error: 'Commit requires a frozen mutation preview' };
    if (preview.workflowName !== input.workflowName || preview.workflowDir !== input.workflowDir) return { code: 'PREVIEW_MISMATCH', error: 'Preview does not belong to this workflow' };
    if (!input.previewId) return { code: 'PREVIEW_REQUIRED', error: 'previewId is required' };
    if (!expected) return { code: 'EXPECTED_HASH_REQUIRED', error: 'expectedHash or baseRevision is required' };
    if (expected !== current.beforeHash) return { code: 'WORKFLOW_CONFLICT', expectedHash: expected, actualHash: current.beforeHash, previewId: input.previewId, message: 'Workflow changed since preview; create a new preview' };
    const validation = await (this.validate?.(JSON.parse(preview.frozenContent), input) || { valid: true, errors: [], warnings: [] });
    const structuralIssues = validateStructure(JSON.parse(preview.frozenContent));
    if (structuralIssues.length > 0) {
      validation.errors = [...(validation.errors || []), ...structuralIssues];
      validation.valid = false;
    }
    const outputIssue = validateOutputs(JSON.parse(preview.frozenContent));
    if (outputIssue) {
      validation.errors = [...(validation.errors || []), { code: 'output_missing', message: outputIssue }];
      validation.valid = false;
    }
    if (validation.valid === false) return { code: 'VALIDATION_FAILED', validation };
    let result;
    try { result = atomicReplace({ targetPath: current.workflowPath, content: preview.frozenContent, expectedHash: current.beforeHash }); } catch (error) { return { code: error.code || 'WORKFLOW_COMMIT_FAILED', error: error.message, expectedHash: error.expectedHash, actualHash: error.actualHash }; }
    const revision = this.revisionStore.saveRevision({ workflowName: input.workflowName, workflowDir: input.workflowDir, workflowPath: current.workflowPath, format: 'ui', afterHash: result.afterHash, beforeHash: current.beforeHash, operations: preview.operations, diff: preview.diff, validation, source: 'workflow_mutation', createdBy: 'agent', createdAt: new Date().toISOString() }, current.content);
    this.invalidateManifest?.(input.workflowName, input.workflowDir);
    return { committed: true, revision: { ...revision, afterHash: hash(preview.frozenContent) }, validation };
  }
}
