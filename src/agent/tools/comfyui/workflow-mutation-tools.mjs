import { ComfyUITool, workflowManifestCache } from './index.mjs';
import { WorkflowMutationService } from './workflow-mutation-service.mjs';
import { createWorkflowRevisionStore } from './workflow-revision-store.mjs';
import { join } from 'node:path';

const previews = new Map();
const defaultStore = createWorkflowRevisionStore({ root: process.env.COMFYUI_AGENT_REVISION_ROOT || join(process.cwd(), '.agent-revisions') });
const service = new WorkflowMutationService({
  revisionStore: defaultStore,
  objectInfoProvider: async () => {
    if (typeof ComfyUITool.client?.objectInfo !== 'function') return {};
    return ComfyUITool.client.objectInfo().catch(() => ({}));
  },
  invalidateManifest: (name, dir) => workflowManifestCache.invalidate(name, dir),
});

function baseSchema() {
  return {
    type: 'object',
    properties: {
      workflowName: { type: 'string' }, workflowDir: { type: 'string' },
      operations: { type: 'array', items: { type: 'object' } }, baseRevision: { type: 'string' },
      baseHash: { type: 'string' }, expectedHash: { type: 'string' }, previewId: { type: 'string' },
      revisionId: { type: 'string' }, confirmation: { type: 'boolean' }, expectedCurrentHash: { type: 'string' },
    }, additionalProperties: false,
  };
}

export const WorkflowMutationPreviewTool = {
  name: 'workflow_mutation_preview', description: 'Preview safe scalar edits to a local UI workflow without writing it.', category: 'workflow', permission: 'read', risk_level: 'low', side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 }, supports_preview: true, supports_rollback: false, output_types: ['patch', 'validation', 'revision'], input_schema: baseSchema(), output_schema: { type: 'object', properties: { ready: { type: 'boolean' }, diff: { type: 'array' }, validation: { type: 'object' }, confirmation: { type: 'object' } } },
  input_schema: { ...baseSchema(), required: ['workflowName', 'workflowDir', 'operations'] }, output_schema: { type: 'object', properties: { ready: { type: 'boolean' }, diff: { type: 'array' }, validation: { type: 'object' }, confirmation: { type: 'object' } } },
  async execute(input) { const result = await service.preview(input); if (result.previewId) previews.set(result.previewId, structuredClone(result)); return result; },
};

export const WorkflowMutationCommitTool = {
  name: 'workflow_mutation_commit', description: 'Commit a confirmed frozen UI workflow mutation preview atomically.', category: 'workflow', permission: 'mutate', risk_level: 'high', side_effects: ['workflow_write'], requires_confirmation: true, idempotent: false, retry: { mode: 'never' }, supports_preview: true, supports_rollback: true, output_types: ['revision', 'validation'], input_schema: baseSchema(), output_schema: { type: 'object', properties: { committed: { type: 'boolean' }, revision: { type: 'object' }, validation: { type: 'object' }, error: { type: 'string' } } },
  input_schema: { ...baseSchema(), required: ['workflowName', 'workflowDir', 'previewId', 'confirmation'] }, output_schema: { type: 'object', properties: { committed: { type: 'boolean' }, revision: { type: 'object' }, validation: { type: 'object' }, error: { type: 'string' } } },
  async execute(input) { const preview = previews.get(input.previewId); if (!preview) return { code: 'PREVIEW_NOT_FOUND', error: 'Mutation preview not found or expired' }; const result = await service.commit(input, preview); if (result.committed) previews.delete(input.previewId); return result; },
};

export const WorkflowRevisionListTool = {
  name: 'workflow_revision_list', description: 'List persisted revisions for a local workflow.', category: 'workflow', permission: 'read', risk_level: 'none', side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'limited', max_attempts: 1 }, output_types: ['revision'], input_schema: { type: 'object', properties: { workflowName: { type: 'string' }, workflowDir: { type: 'string' } }, required: ['workflowName', 'workflowDir'], additionalProperties: false }, output_schema: { type: 'object', properties: { revisions: { type: 'array' } } },
  async execute(input) { return { workflowName: input.workflowName, revisions: defaultStore.listRevisions(input.workflowDir, input.workflowName) }; },
};

export const WorkflowRollbackTool = {
  name: 'workflow_rollback', description: 'Rollback a workflow to a persisted revision after explicit confirmation.', category: 'workflow', permission: 'mutate', risk_level: 'high', side_effects: ['workflow_write', 'workflow_rollback'], requires_confirmation: true, idempotent: false, retry: { mode: 'never' }, supports_rollback: true, output_types: ['revision', 'validation'], input_schema: { type: 'object', properties: { workflowName: { type: 'string' }, workflowDir: { type: 'string' }, revisionId: { type: 'string' }, expectedCurrentHash: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['workflowName', 'workflowDir', 'revisionId', 'confirmation'], additionalProperties: false }, output_schema: { type: 'object', properties: { committed: { type: 'boolean' }, revision: { type: 'object' }, error: { type: 'string' } } },
  async execute(input) { if (input.confirmation !== true) return { code: 'CONFIRMATION_REQUIRED', error: 'Rollback requires confirmation' }; const target = defaultStore.getRevision(input.workflowDir, input.workflowName, input.revisionId); if (!target || target.status !== 'committed') return { code: 'REVISION_NOT_FOUND', error: 'Committed revision not found' }; const current = await service.load(input); const expected = input.expectedCurrentHash || target.afterHash; if (expected !== current.beforeHash) return { code: 'ROLLBACK_CONFLICT', expectedHash: expected, actualHash: current.beforeHash }; const content = (await import('node:fs')).readFileSync(target.backupFile, 'utf8'); const { atomicReplace, bufferHash } = await import('../filesystem/atomic-write.mjs'); let result; try { result = atomicReplace({ targetPath: current.workflowPath, content, expectedHash: current.beforeHash }); } catch (error) { return { code: error.code || 'ROLLBACK_FAILED', error: error.message, expectedHash: error.expectedHash, actualHash: error.actualHash }; } const saved = defaultStore.saveRevision({ workflowName: input.workflowName, workflowDir: input.workflowDir, workflowPath: current.workflowPath, format: 'ui', parentRevisionId: target.revisionId, beforeHash: current.beforeHash, afterHash: result.afterHash || bufferHash(Buffer.from(content)), source: 'workflow_rollback', createdBy: 'agent', createdAt: new Date().toISOString(), status: 'committed' }, current.content); workflowManifestCache.invalidate(input.workflowName, input.workflowDir); return { committed: true, revision: saved }; },
};

export const WorkflowMutationTools = [WorkflowMutationPreviewTool, WorkflowMutationCommitTool, WorkflowRevisionListTool, WorkflowRollbackTool];
