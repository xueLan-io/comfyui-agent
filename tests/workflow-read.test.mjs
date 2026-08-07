import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { WorkflowReadTool, WorkflowListNodesTool, WorkflowFindNodesTool } from '../src/agent/tools/comfyui/workflow-read.mjs';
import { img2imgWorkflow, img2imgObjectInfo } from './fixtures/img2img-workflow.mjs';

test('workflow read is sandboxed and workflow nodes remain literal-query based', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-read-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'sample.json'), JSON.stringify(img2imgWorkflow()));
  const original = ComfyUITool.client; ComfyUITool.setClient({ objectInfo: async () => img2imgObjectInfo() });
  t.after(() => ComfyUITool.setClient(original));
  const raw = await WorkflowReadTool.execute({ workflowName: 'sample.json', workflowDir: dir }); assert.equal(raw.workflow.nodes.length, 11);
  await assert.rejects(() => WorkflowReadTool.execute({ workflowName: '../sample.json', workflowDir: dir }));
  const nodes = await WorkflowListNodesTool.execute({ workflowName: 'sample.json', workflowDir: dir, activeOnly: false }); assert.equal(nodes.count, 11);
  const found = await WorkflowFindNodesTool.execute({ workflowName: 'sample.json', workflowDir: dir, type: 'textencode', value: 'bad quality' }); assert.equal(found.count, 1);
});
