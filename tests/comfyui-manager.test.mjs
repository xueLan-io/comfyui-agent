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

test('does not start ComfyUI after shutdown has begun', async () => {
  const manager = new ComfyUIManager();
  manager.portableRoot = 'C:\\portable';
  manager.shuttingDown = true;
  manager.checkHealth = async () => false;
  manager._spawnProcess = () => { throw new Error('must not spawn after shutdown'); };

  const state = await manager.ensureStarted();

  assert.equal(state.status, 'stopped');
  assert.equal(manager.process, null);
});

test('serializes managed startup across manager instances', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'comfyui-startup.lock');
  const first = new ComfyUIManager({ startupLockPath: lockPath });
  const second = new ComfyUIManager({ startupLockPath: lockPath });

  assert.equal(first._acquireStartupLock().acquired, true);
  assert.equal(second._acquireStartupLock().acquired, false);
  first._releaseStartupLock();
  assert.equal(second._acquireStartupLock().acquired, true);
  second._releaseStartupLock();
});

test('cleans up a failed startup process and releases its lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'comfyui-startup.lock');
  const manager = new ComfyUIManager({ startupLockPath: lockPath });
  manager.portableRoot = root;
  manager.checkHealth = async () => false;
  manager._spawnProcess = () => { manager.process = { pid: 42 }; };
  manager.killTree = () => true;
  const state = await manager.ensureStarted({ timeoutMs: 1 });
  assert.equal(state.status, 'error');
  assert.equal(manager.process, null);
  assert.equal(manager.startupLockHeld, false);
});

test('changing the startup lock path releases the old lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-agent-lock-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstPath = join(root, 'first.lock');
  const secondPath = join(root, 'second.lock');
  const manager = new ComfyUIManager({ startupLockPath: firstPath });
  assert.equal(manager._acquireStartupLock().acquired, true);
  manager.setStartupLockPath(secondPath);
  assert.equal(manager.startupLockHeld, false);
  assert.equal(manager._acquireStartupLock().acquired, true);
  manager._releaseStartupLock();
});
