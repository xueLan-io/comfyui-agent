import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { JSONFileStore } from '../src/agent/memory/store.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'comfy-agent-store-'));
}

test('set/get roundtrip', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'tasks.json');
    await store.load();
    store.set('messages', [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(store.get('messages'), [{ role: 'user', content: 'hi' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save persists data for a new instance', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'conversations.json');
    await store.load();
    store.set('project', { name: 'demo' });
    await store.save();

    const reloaded = new JSONFileStore(dir, 'conversations.json');
    await reloaded.load();
    assert.deepEqual(reloaded.get('project'), { name: 'demo' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic write leaves no tmp files behind', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'tasks.json');
    await store.load();
    store.set('tasks', [1, 2, 3]);
    await store.save();

    const files = readdirSync(dir);
    assert.ok(files.includes('tasks.json'));
    assert.ok(!files.some(f => f.endsWith('.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load from missing file falls back to defaults', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'absent.json', { version: 1 });
    await store.load();
    assert.deepEqual(store.get('version'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load from corrupt file falls back to defaults', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'broken.json', { version: 2 });
    const { writeFileSync } = await import('fs');
    writeFileSync(store.filePath, '{not valid json');
    await store.load();
    assert.deepEqual(store.get('version'), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load from corrupt file preserves the original as a backup', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'broken.json', { version: 3 });
    const { writeFileSync } = await import('fs');
    writeFileSync(store.filePath, '{not valid json');
    await store.load();
    const files = readdirSync(dir);
    const backups = files.filter(file => file.startsWith('broken.json.corrupt-'));
    assert.equal(backups.length, 1);
    const { readFileSync } = await import('fs');
    assert.equal(readFileSync(join(dir, backups[0]), 'utf-8'), '{not valid json');
    assert.equal(store.get('version'), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load from missing file does not create a corrupt backup', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'absent.json', { version: 1 });
    await store.load();
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(store.get('version'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
