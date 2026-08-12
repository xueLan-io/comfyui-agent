import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGlobalPresets, createGlobalPreset, updateGlobalPreset, deleteGlobalPreset, rateGlobalPreset, composeGlobalPresets } from '../src/runtime/global-presets.mjs';

test('global presets persist defaults and lifecycle updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const created = await createGlobalPreset(root, { title: 'Test', positive: 'portrait', tags: ['人物'] });
  assert.match(created.id, /^preset_/);
  assert.equal((await listGlobalPresets(root)).length, 1);
  const updated = await updateGlobalPreset(root, created.id, { favorite: true, description: 'desc' });
  assert.equal(updated.favorite, true);
  assert.equal((await deleteGlobalPreset(root, created.id)).length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'presets.json'), 'utf8')), []);
});

test('global presets require a positive prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  await assert.rejects(() => createGlobalPreset(root, { title: 'Invalid' }), /正向提示词不能为空/);
});

test('a workflow name is retained as metadata without requiring a workflow file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const created = await createGlobalPreset(root, { title: 'Historical', positive: 'portrait', workflowName: 'deleted-workflow.json' });
  assert.equal(created.workflowName, 'deleted-workflow.json');
  assert.equal(created.workflow, '');
});

test('global preset resources are copied and deleted with the preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const source = join(root, 'input.png');
  await writeFile(source, 'png');
  const created = await createGlobalPreset(root, { title: 'Assets', positive: 'portrait', resultPaths: [source], coverSourcePath: source });
  assert.equal(created.resultImages.length, 1);
  await stat(join(root, created.resultImages[0].path));
  await stat(join(root, created.cover.path));
  await deleteGlobalPreset(root, created.id);
  await assert.rejects(() => stat(join(root, created.resultImages[0].path)));
  await assert.rejects(() => stat(join(root, created.cover.path)));
});

test('global preset resource updates replace and clear old resources atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const first = join(root, 'first.png');
  const second = join(root, 'second.jpg');
  await writeFile(first, 'png');
  await writeFile(second, 'jpg');
  const created = await createGlobalPreset(root, { title: 'Assets', positive: 'portrait', resultPaths: [first], coverSourcePath: first });
  const updated = await updateGlobalPreset(root, created.id, { resultPaths: [second], coverSourcePath: second });
  assert.equal(updated.resultImages.length, 1);
  assert.match(updated.resultImages[0].path, /\.jpg$/);
  assert.match(updated.cover.path, /\.jpg$/);
  await assert.rejects(() => stat(join(root, created.resultImages[0].path)));
  await assert.rejects(() => stat(join(root, created.cover.path)));
  const cleared = await updateGlobalPreset(root, created.id, { resultPaths: [], coverSourcePath: '' });
  assert.deepEqual(cleared.resultImages, []);
  assert.equal(cleared.cover, null);
  await assert.rejects(() => readdir(join(root, 'results', created.id)));
});

test('global preset resource failures restore the previous version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const source = join(root, 'first.png');
  const missing = join(root, 'missing.png');
  await writeFile(source, 'png');
  const created = await createGlobalPreset(root, { title: 'Assets', positive: 'portrait', resultPaths: [source] });
  await assert.rejects(() => updateGlobalPreset(root, created.id, { resultPaths: [missing] }));
  const current = (await listGlobalPresets(root))[0];
  assert.deepEqual(current.resultImages, created.resultImages);
  await stat(join(root, created.resultImages[0].path));
  assert.deepEqual((await readdir(join(root, 'results'))).filter(name => name.includes('.bak')), []);
});

test('global presets keep versions, ratings, and composed components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-presets-'));
  const first = await createGlobalPreset(root, { title: 'Style', positive: 'portrait', parameters: { steps: 20 }, tags: ['style'] });
  const second = await createGlobalPreset(root, { title: 'Lighting', positive: 'soft light', parameters: { cfg: 6 }, tags: ['light'] });
  const updated = await updateGlobalPreset(root, first.id, { positive: 'portrait, detailed' });
  assert.equal(updated.versions.length, 1);
  const rated = await rateGlobalPreset(root, first.id, 5);
  assert.equal(rated.rating, 5);
  assert.equal(rated.ratingCount, 1);
  const composed = await composeGlobalPresets(root, [first.id, second.id], { title: 'Portrait Recipe' });
  assert.equal(composed.title, 'Portrait Recipe');
  assert.equal(composed.origin, 'composition');
  assert.deepEqual(composed.components, [first.id, second.id]);
  assert.match(composed.positive, /portrait, detailed/);
  assert.match(composed.positive, /soft light/);
});
