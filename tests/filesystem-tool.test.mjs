import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemTool } from '../src/agent/tools/filesystem/index.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-fs-'));
  const workflowDir = join(base, 'workflows');
  const outputDir = join(base, 'output');
  mkdirSync(workflowDir);
  mkdirSync(outputDir);
  writeFileSync(join(workflowDir, 'test.json'), JSON.stringify({ nodes: [], links: [] }));
  return { base, workflowDir, outputDir };
}

function roots({ workflowDir, outputDir }) {
  return [
    { name: 'workflow', path: workflowDir },
    { name: 'output', path: outputDir },
  ];
}

test('filesystem reads only relative paths inside trusted roots', async () => {
  const paths = fixture();
  try {
    const allowedRoots = roots(paths);
    const listed = await FilesystemTool.execute({ action: 'list', workflowDir: paths.workflowDir, allowedRoots });
    assert.deepEqual(listed.files.map(file => file.name), ['test.json']);

    await assert.rejects(
      () => FilesystemTool.execute({ action: 'read', workflowDir: paths.workflowDir, filename: '../secret.json', allowedRoots }),
      /relative path|outside/i,
    );
    await assert.rejects(
      () => FilesystemTool.execute({ action: 'read', workflowDir: paths.workflowDir, filename: join(paths.base, 'secret.json'), allowedRoots }),
      /relative path|outside/i,
    );
    await assert.rejects(
      () => FilesystemTool.execute({ action: 'list_images', workflowDir: paths.workflowDir, root: 'output', outputDir: paths.base, allowedRoots }),
      /relative path|outside/i,
    );
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('filesystem rejects symlink paths and write actions', async (t) => {
  const paths = fixture();
  const outside = join(paths.base, 'outside.json');
  const link = join(paths.workflowDir, 'escape.json');
  writeFileSync(outside, '{}');
  try {
    try {
      symlinkSync(outside, link);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSYS'].includes(error.code)) {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => FilesystemTool.execute({ action: 'read', workflowDir: paths.workflowDir, filename: 'escape.json', allowedRoots: roots(paths) }),
      /symbolic|outside/i,
    );
    const result = await FilesystemTool.execute({
      action: 'write',
      workflowDir: paths.workflowDir,
      path: join(paths.base, 'should-not-exist.txt'),
      content: 'blocked',
      allowedRoots: roots(paths),
    });
    assert.match(result.error, /Unknown action/);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});
