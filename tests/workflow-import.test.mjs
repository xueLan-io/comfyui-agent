import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectWorkflowFiles, deleteWorkflowFile, importWorkflowFiles, isComfyWorkflowJson, renameWorkflowFile, resolveWorkflowFilePath, uniqueWorkflowName } from '../src/runtime/workflow-import.mjs';
import { img2imgWorkflow } from './fixtures/img2img-workflow.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('isComfyWorkflowJson accepts UI and API formats', () => {
  assert.equal(isComfyWorkflowJson(JSON.stringify(img2imgWorkflow())), true);
  assert.equal(isComfyWorkflowJson(JSON.stringify({ '3': { class_type: 'KSampler', inputs: {} } })), true);
  assert.equal(isComfyWorkflowJson(JSON.stringify({ nodes: [] })), false);
  assert.equal(isComfyWorkflowJson(JSON.stringify({ hello: 'world' })), false);
  assert.equal(isComfyWorkflowJson(JSON.stringify([1, 2, 3])), false);
  assert.equal(isComfyWorkflowJson('not json'), false);
  assert.equal(isComfyWorkflowJson(''), false);
});

test('uniqueWorkflowName appends (2), (3) when conflicts exist', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'base.json'), '{}');
  await writeFile(join(dir, 'base (2).json'), '{}');
  assert.equal(await uniqueWorkflowName(dir, 'base.json'), 'base (3).json');
  assert.equal(await uniqueWorkflowName(dir, 'fresh.json'), 'fresh.json');
});

test('collectWorkflowFiles recurses subdirectories and skips backup files', async t => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'a.json'), '{}');
  await writeFile(join(dir, 'backup-a.json'), '{}');
  await writeFile(join(dir, 'sub', 'b.json'), '{}');
  await writeFile(join(dir, 'sub', 'c.txt'), '');
  assert.deepEqual(collectWorkflowFiles(dir), ['a.json', join('sub', 'b.json')]);
});

test('importWorkflowFiles copies valid workflows and renames duplicates', async t => {
  const dir = await tempDir(t);
  const source = join(dir, '..', 'source.json');
  const sourceDir = await mkdtemp(join(tmpdir(), 'comfy-import-src-'));
  t.after(() => rm(sourceDir, { recursive: true, force: true }));
  const sourcePath = join(sourceDir, 'external.json');
  await writeFile(sourcePath, JSON.stringify(img2imgWorkflow()));
  const sourcePath2 = join(sourceDir, 'duplicate.json');
  await writeFile(sourcePath2, JSON.stringify(img2imgWorkflow()));

  const first = await importWorkflowFiles([sourcePath], dir);
  assert.deepEqual(first.results, [{ name: 'external.json', status: 'imported' }]);
  assert.deepEqual(first.imported, ['external.json']);
  assert.ok(first.files.includes('external.json'));

  const second = await importWorkflowFiles([sourcePath2, sourcePath], dir);
  assert.deepEqual(second.results, [
    { name: 'duplicate.json', status: 'imported' },
    { name: 'external (2).json', status: 'imported' },
  ]);
  assert.ok(second.files.includes('external.json'));
  assert.ok(second.files.includes('external (2).json'));
  const copied = JSON.parse(await readFile(join(dir, 'external (2).json'), 'utf-8'));
  assert.ok(Array.isArray(copied.nodes));
});

test('importWorkflowFiles rejects invalid content and unreadable files', async t => {
  const dir = await tempDir(t);
  const sourceDir = await mkdtemp(join(tmpdir(), 'comfy-import-src2-'));
  t.after(() => rm(sourceDir, { recursive: true, force: true }));
  const badPath = join(sourceDir, 'bad.json');
  await writeFile(badPath, '{"foo": 1}');
  const missingPath = join(sourceDir, 'missing.json');

  const result = await importWorkflowFiles([badPath, missingPath], dir);
  assert.equal(result.imported.length, 0);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'invalid');
  assert.equal(result.results[1].status, 'unreadable');
});

test('resolveWorkflowFilePath returns resolved in-dir path and rejects escape', async t => {
  const dir = await tempDir(t);
  const basePath = resolveWorkflowFilePath(dir, 'a.json');
  assert.equal(basePath, join(dir, 'a.json'));
  assert.ok(basePath.startsWith(dir));
  assert.throws(() => resolveWorkflowFilePath(dir, ''));
  assert.throws(() => resolveWorkflowFilePath(dir, '../evil.json'));
  assert.equal(resolveWorkflowFilePath(dir, 'sub/evil.json'), join(dir, 'sub', 'evil.json'));
});

test('renameWorkflowFile renames and rejects duplicate / missing', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'a.json'), '{}');
  const renamed = await renameWorkflowFile('a.json', 'b.json', dir);
  assert.equal(renamed.renamed, 'b.json');
  assert.deepEqual(renamed.files, ['b.json']);

  await writeFile(join(dir, 'a.json'), '{}');
  await assert.rejects(renameWorkflowFile('a.json', 'b.json', dir), /已存在同名工作流/);
  await assert.rejects(renameWorkflowFile('missing.json', 'c.json', dir), /工作流不存在/);
  await assert.rejects(renameWorkflowFile('../evil.json', 'c.json', dir), /工作流路径超出配置目录/);
});

test('deleteWorkflowFile deletes file, prunes empty dirs and rejects missing', async t => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'a.json'), '{}');
  await writeFile(join(dir, 'keep.json'), '{}');

  const deleted = await deleteWorkflowFile(join('sub', 'a.json'), dir);
  assert.equal(deleted.deleted, join('sub', 'a.json'));
  assert.deepEqual(deleted.files, ['keep.json']);

  await assert.rejects(deleteWorkflowFile('missing.json', dir), /工作流不存在/);
  await assert.rejects(deleteWorkflowFile('../evil.json', dir), /工作流路径超出配置目录/);
});
