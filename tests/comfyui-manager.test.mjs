import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUIManager, findPortableRoot } from '../electron/comfyui-manager.mjs';

test('finds the portable root from a nested Agent directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const nested = join(root, 'ComfyUI', 'agent', 'electron');
  await mkdir(join(root, 'python_embeded'), { recursive: true });
  await mkdir(join(root, 'ComfyUI', 'user', 'default', 'workflows'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, 'python_embeded', 'python.exe'), '');
  await writeFile(join(root, 'ComfyUI', 'main.py'), '');

  assert.equal(findPortableRoot(nested), root);

  const manager = new ComfyUIManager({ startDirs: [nested] });
  assert.equal(manager.workflowDir, join(root, 'ComfyUI', 'user', 'default', 'workflows'));
});

test('returns an empty root when the portable runtime is absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(findPortableRoot(root), '');
});

test('refreshes a stale starting state when ComfyUI is already healthy', async () => {
  const statuses = [];
  const manager = new ComfyUIManager({ onStatus: state => statuses.push(state.status) });
  manager.state.status = 'starting';
  manager.checkHealth = async () => true;

  const state = await manager.refreshState();

  assert.equal(state.status, 'ready');
  assert.equal(statuses.at(-1), 'ready');
});

test('marks a previously ready ComfyUI connection as disconnected', async () => {
  const manager = new ComfyUIManager();
  manager.state.status = 'ready';
  manager.checkHealth = async () => false;

  const state = await manager.refreshState();

  assert.equal(state.status, 'disconnected');
});

test('stops the full process tree owned by the manager', () => {
  let stoppedPid = 0;
  const manager = new ComfyUIManager({
    killTree: child => {
      stoppedPid = child.pid;
      return true;
    },
  });
  manager.process = { pid: 4321 };

  assert.equal(manager.stopOwned(), true);
  assert.equal(stoppedPid, 4321);
  assert.equal(manager.process, null);
  assert.equal(manager.stopOwned(), false);
});
