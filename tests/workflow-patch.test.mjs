import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { WorkflowPatchTool } from '../src/agent/tools/comfyui/workflow-patch.mjs';
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

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-patch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('preview builds a settings diff with current and target values', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
    settings: { steps: 32, cfg: 8.5 },
  }));
  assert.equal(result.ready, true);
  const steps = result.diff.find(entry => entry.nodeId === '9' && entry.input === 'steps');
  assert.equal(steps.from, 28);
  assert.equal(steps.to, 32);
  assert.equal(steps.nodeType, 'KSampler');
  assert.equal(result.compiledSettings.steps, 32);
  assert.equal(result.compiledSettings.cfg, 8.5);
  assert.ok(result.diff.length >= 2);
});

test('preview keeps the original workflow unchanged', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
    settings: { steps: 99 },
  }));
  const original = JSON.parse(await import('node:fs/promises').then(m => m.readFile(join(dir, 'img2img.json'), 'utf-8')));
  const sampler = original.nodes.find(node => node.id === 9);
  assert.equal(sampler.widgets_values[1], 28);
});

test('preview reports node overrides and prompt injection changes', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
    nodeOverrides: { '7': { text: 'a red cat' } },
    positivePrompts: ['a red cat'],
    negative: 'lowres',
  }));
  const text = result.diff.find(entry => entry.nodeId === '7' && entry.input === 'text');
  assert.equal(text.from, 'a cat');
  assert.equal(text.to, 'a red cat');
  assert.equal(result.compiledNodeOverrides.length, 1);
});

test('preview reports ignored changes for linked inputs', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
    nodeOverrides: { '9': { model: 'cannot-edit' } },
  }));
  assert.ok(result.ignored.some(item => item.nodeId === '9' && item.input === 'model' && item.reason === 'linked_input'));
});

test('preview shows injected input media against the current image', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
    media: { images: [{ name: 'reference.png', subfolder: 'refs' }] },
  }));
  const image = result.diff.find(entry => entry.nodeId === '5' && entry.input === 'image');
  assert.equal(image.from, 'input.png');
  assert.equal(image.to, 'refs/reference.png');
});

test('preview returns an error for a missing workflow', async t => {
  const dir = await tempDir(t);
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'missing.json', workflowDir: dir,
    settings: { steps: 32 },
  }));
  assert.match(result.error, /not found/);
  assert.equal(result.diff, undefined);
});

test('preview is not ready when nothing would change', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'img2img.json'), JSON.stringify(img2imgWorkflow()));
  const client = { async objectInfo() { return img2imgObjectInfo(); } };

  const result = await withClient(client, () => WorkflowPatchTool.execute({
    action: 'preview', workflow: 'img2img.json', workflowDir: dir,
  }));
  assert.equal(result.diff.length, 0);
  assert.equal(result.ready, false);
});
