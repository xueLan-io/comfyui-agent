import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { WorkflowInspectTool } from '../src/agent/tools/comfyui/workflow-inspect.mjs';
import { img2imgWorkflow, img2imgObjectInfo } from './fixtures/img2img-workflow.mjs';

async function withClient(client, fn) {
  const original = ComfyUITool.client;
  ComfyUITool.setClient(client);
  try {
    return await fn();
  } finally {
    ComfyUITool.setClient(original);
  }
}

function clientWith(objectInfo = img2imgObjectInfo(), inspectResult = { exists: true }) {
  return {
    async objectInfo() {
      return objectInfo;
    },
    async inspectImage(ref) {
      return { filename: ref.filename, ...inspectResult };
    },
  };
}

async function writeWorkflow(dir, workflow) {
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(workflow));
  return join(dir, 'img2img.json');
}

test('snapshot lists nodes, sampler, links, and model files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const result = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'snapshot', workflowName: 'img2img.json', workflowDir: dir,
  }));
  assert.equal(result.workflowName, 'img2img.json');
  assert.equal(result.nodeCount, 11);
  assert.deepEqual(result.sampler, { steps: 28, cfg: 7, denoise: 0.8, sampler_name: 'euler_ancestral', scheduler: 'normal' });
  assert.equal(result.links.length, 11);
  assert.equal(result.modelFiles.length, 4);
  const sampler = result.nodes.find(node => node.type === 'KSampler');
  assert.equal(sampler.id, '9');
  assert.equal(sampler.group, 'Sampling');
  assert.ok(sampler.inputs.find(input => input.name === 'steps' && input.value === 28 && input.editable === true));
  assert.ok(sampler.inputs.find(input => input.name === 'positive' && input.value.linked === 'CLIPTextEncode #7' && input.editable === false));
  assert.ok(result.outputNodes.some(node => node.type === 'SaveImage'));
});

test('node action returns a single node with grouped inputs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const result = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'node', workflowName: 'img2img.json', workflowDir: dir, nodeId: '7',
  }));
  assert.equal(result.node.type, 'CLIPTextEncode');
  assert.equal(result.node.inputs.find(input => input.name === 'text').value, 'a cat');
  assert.equal(result.node.inputs.find(input => input.name === 'clip').value.linked, 'CLIPLoader #2');
});

test('node action reports an inactive or unknown node', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const result = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'node', workflowName: 'img2img.json', workflowDir: dir, nodeId: '99',
  }));
  assert.match(result.error, /not active/);
});

test('find matches by type fragment and value', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const byType = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'find', workflowName: 'img2img.json', workflowDir: dir, type: 'textencode',
  }));
  assert.equal(byType.count, 2);

  const byValue = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'find', workflowName: 'img2img.json', workflowDir: dir, value: 'bad quality',
  }));
  assert.equal(byValue.count, 1);
  assert.equal(byValue.matches[0].id, '8');
});

test('validate passes for a healthy img2img workflow', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const result = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'validate', workflowName: 'img2img.json', workflowDir: dir,
  }));
  assert.equal(result.valid, true);
  assert.equal(result.errorCount, 0);
  assert.equal(result.sampler.steps, 28);
  assert.equal(result.modelReady, true);
  assert.equal(typeof result.adapterAvailable, 'boolean');
  assert.ok(Array.isArray(result.issues));
});

test('validate flags broken links, missing models, and out-of-range denoise', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workflow = img2imgWorkflow({
    nodes: img2imgWorkflow().nodes.map(node =>
      node.id === 9 ? { ...node, widgets_values: [42, 28, 7, 'euler_ancestral', 'normal', 1.5] } : node),
    links: img2imgWorkflow().links.map(link =>
      link[0] === 11 ? [11, 10, 5, 11, 0] : link),
  });
  await writeWorkflow(dir, workflow);

  const result = await withClient(clientWith(img2imgObjectInfo({ unet: ['only-other.safetensors'] })), () => WorkflowInspectTool.execute({
    action: 'validate', workflowName: 'img2img.json', workflowDir: dir,
  }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === 'broken_link'));
  assert.ok(result.issues.some(issue => issue.code === 'model_missing'));
  assert.equal(result.modelReady, false);
  assert.equal(result.errorCount, result.issues.filter(issue => issue.severity === 'error').length);
  assert.ok(result.issues.some(issue => issue.code === 'denoise_range'));
});

test('validate reports a missing input media file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeWorkflow(dir, img2imgWorkflow());

  const result = await withClient(clientWith(img2imgObjectInfo(), { exists: false }), () => WorkflowInspectTool.execute({
    action: 'validate', workflowName: 'img2img.json', workflowDir: dir,
  }));
  assert.ok(result.issues.some(issue => issue.code === 'input_media_missing'));
});

test('inspect returns a workflow-not-found error for an unknown file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-inspect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await withClient(clientWith(), () => WorkflowInspectTool.execute({
    action: 'snapshot', workflowName: 'nope.json', workflowDir: dir,
  }));
  assert.match(result.error, /not found/);
});
