import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowMutationService } from '../src/agent/tools/comfyui/workflow-mutation-service.mjs';
import { WorkflowRevisionStore } from '../src/agent/tools/comfyui/workflow-revision-store.mjs';

function fixture() {
  return { nodes: [
    { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgets_values: [] },
    { id: 12, type: 'KSampler', mode: 0, inputs: [{ name: 'steps', link: null }, { name: 'positive', link: 7 }], widgets_values: [20, 7] },
    { id: 20, type: 'SaveImage', mode: 0, inputs: [], widgets_values: [] },
  ], links: [[7, 1, 0, 12, 1]], groups: [] };
}
const objectInfo = { KSampler: { input_order: { required: ['steps', 'positive'] }, input: { required: { steps: ['INT', { min: 1, max: 100 }], positive: ['CONDITIONING'] } } } };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-mutation-'));
  writeFileSync(join(dir, 'test.json'), JSON.stringify(fixture(), null, 2));
  const revisions = new WorkflowRevisionStore({ root: join(dir, '.agent-revisions') });
  const service = new WorkflowMutationService({ revisionStore: revisions, objectInfoProvider: async () => objectInfo });
  return { dir, service, revisions, path: join(dir, 'test.json') };
}

test('workflow mutation preview supports scalar input and remains read-only', async () => {
  const { dir, service, path } = setup();
  const before = readFileSync(path, 'utf8');
  const result = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'steps', value: 30 }] });
  assert.equal(result.ready, true);
  assert.equal(result.diff[0].from, 20);
  assert.equal(result.diff[0].to, 30);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('workflow mutation rejects API prompts, linked inputs, invalid values, and unsupported operations', async () => {
  const { dir, service, path } = setup();
  writeFileSync(path, JSON.stringify({ '12': { class_type: 'KSampler', inputs: {} } }));
  const api = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [] });
  assert.equal(api.code, 'WORKFLOW_FORMAT_UNSUPPORTED');
  writeFileSync(path, JSON.stringify(fixture()));
  await assert.rejects(() => service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'positive', value: 'bad' }] }), /linked/);
  await assert.rejects(() => service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'steps', value: 101 }] }), /maximum/);
  await assert.rejects(() => service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'add_node', nodeId: '3' }] }), /Unsupported/);
});

test('workflow mutation reports no-op and rejects output removal', async () => {
  const { dir, service } = setup();
  const noOp = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'steps', value: 20 }] });
  assert.equal(noOp.ready, false);
  assert.deepEqual(noOp.warnings, ['no_changes']);
  const disabled = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_property', nodeId: '20', path: 'mode', value: 4 }] });
  assert.equal(disabled.ready, false);
  assert.match(disabled.validation.errors[0].message, /active output/);
});

test('workflow mutation commit enforces confirmation and optimistic hash', async () => {
  const { dir, service, path, revisions } = setup();
  const preview = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'steps', value: 30 }] });
  assert.equal((await service.commit({ workflowName: 'test.json', workflowDir: dir, previewId: preview.previewId, confirmation: false }, preview)).code, 'CONFIRMATION_REQUIRED');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  const conflict = await service.commit({ workflowName: 'test.json', workflowDir: dir, previewId: preview.previewId, expectedHash: preview.baseRevision.sha256, confirmation: true }, preview);
  assert.equal(conflict.code, 'WORKFLOW_CONFLICT');
  const fresh = await service.preview({ workflowName: 'test.json', workflowDir: dir, operations: [{ op: 'set_input', nodeId: '12', input: 'steps', value: 30 }] });
  const committed = await service.commit({ workflowName: 'test.json', workflowDir: dir, previewId: fresh.previewId, expectedHash: fresh.baseRevision.sha256, confirmation: true }, fresh);
  assert.equal(committed.committed, true);
  assert.equal(revisions.listRevisions(dir, 'test.json').length, 1);
});
