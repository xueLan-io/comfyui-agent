import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { displayPath } from '../src/runtime/path-display.mjs';
import {
  projectAssetRoot,
  removeEmptyAssetDirectories,
  scanProjectAssets,
} from '../src/runtime/project-assets.mjs';

test('scans legacy image and video folders with normalized metadata', async () => {
  const dir = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'comfy-assets-'));
  try {
    await mkdir(join(dir, 'images', 'task-old'), { recursive: true });
    await mkdir(join(dir, 'videos', 'task-video'), { recursive: true });
    await writeFile(join(dir, 'images', 'task-old', 'legacy.png'), 'image');
    await writeFile(join(dir, 'images', 'task-old', 'without-index.webp'), 'image');
    await writeFile(join(dir, 'videos', 'task-video', 'result.mp4'), 'video');

    const assets = await scanProjectAssets({
      project: {
        id: 'project-1',
        dir,
        assets: [{ filename: 'legacy.png', subfolder: 'images\\task-old', sessionId: 'session-old' }],
      },
      readTrace: async taskId => taskId === 'task-video' ? { sessionId: 'session-video' } : null,
    });

    assert.equal(assets.length, 3);
    assert.equal(assets.find(asset => asset.filename === 'legacy.png').sessionId, 'session-old');
    assert.equal(assets.find(asset => asset.filename === 'without-index.webp').sessionId, '');
    assert.equal(assets.find(asset => asset.filename === 'result.mp4').sessionId, 'session-video');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removes empty asset folders without removing the asset root', async () => {
  const dir = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'comfy-assets-delete-'));
  try {
    const root = join(dir, 'images');
    const taskDir = join(root, 'task', 'nested');
    const file = join(taskDir, 'image.png');
    await mkdir(taskDir, { recursive: true });
    await writeFile(file, 'image');
    await rm(file);
    await removeEmptyAssetDirectories(file, root);

    await assert.rejects(() => stat(taskDir), { code: 'ENOENT' });
    await assert.rejects(() => stat(join(root, 'task')), { code: 'ENOENT' });
    assert.equal((await stat(root)).isDirectory(), true);
    assert.equal(projectAssetRoot(dir, join(root, 'task', 'image.png')), root);
    assert.equal(projectAssetRoot(dir, join(dir, 'other', 'image.png')), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renders known system folders as Chinese display labels', () => {
  const root = 'C:\\Users\\Administrator';
  assert.equal(displayPath(`${root}\\Desktop\\workflows`, [{ path: `${root}\\Desktop`, label: '桌面' }]), '桌面\\workflows');
  assert.equal(displayPath(`${root}\\Documents`, [{ path: `${root}\\Desktop`, label: '桌面' }]), `${root}\\Documents`);
});
