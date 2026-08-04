import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SandboxViolation,
  assertSandboxMedia,
  createSandboxPolicy,
  resolveSandboxFile,
  resolveSandboxPath,
  SANDBOX_AUTHORIZED_FILES,
} from '../src/agent/security/sandbox.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-sandbox-'));
  const workflowDir = join(base, 'workflow');
  const inputDir = join(base, 'input');
  mkdirSync(workflowDir);
  mkdirSync(inputDir);
  writeFileSync(join(workflowDir, 'test.json'), '{}');
  writeFileSync(join(inputDir, 'image.png'), 'image');
  return { base, workflowDir, inputDir };
}

function input(paths, extra = {}) {
  return {
    workflowDir: paths.workflowDir,
    allowedRoots: [{ name: 'input', path: paths.inputDir }],
    ...extra,
  };
}

test('sandbox resolves only canonical paths inside trusted roots', () => {
  const paths = fixture();
  try {
    assert.equal(resolveSandboxPath(input(paths), 'test.json'), join(paths.workflowDir, 'test.json'));
    assert.equal(resolveSandboxFile(input(paths), join(paths.inputDir, 'image.png')), join(paths.inputDir, 'image.png'));
    assert.throws(() => resolveSandboxPath(input(paths), '../secret.json'), SandboxViolation);
    assert.throws(() => resolveSandboxFile(input(paths), join(paths.base, 'secret.txt')), SandboxViolation);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('sandbox rejects symlink escapes', t => {
  const paths = fixture();
  const outside = join(paths.base, 'outside.txt');
  const link = join(paths.workflowDir, 'link.txt');
  writeFileSync(outside, 'outside');
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
    assert.throws(() => resolveSandboxPath(input(paths), 'link.txt'), /symbolic|outside/i);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('sandbox accepts explicitly authorized user-selected media', () => {
  const paths = fixture();
  const selected = join(paths.base, 'selected.png');
  writeFileSync(selected, 'image');
  try {
    assert.doesNotThrow(() => assertSandboxMedia(input(paths, {
      images: [{ path: selected }],
      [SANDBOX_AUTHORIZED_FILES]: [selected],
    })));
    assert.throws(() => assertSandboxMedia(input(paths, { images: [{ path: selected }] })), /outside/i);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('sandbox policy blocks network calls when disabled', () => {
  const policy = createSandboxPolicy({ allowNetwork: false });
  assert.throws(() => policy.assertToolCall('web', { action: 'search' }), /Network access is disabled/);
  assert.doesNotThrow(() => policy.assertToolCall('system', { action: 'status' }));
});
