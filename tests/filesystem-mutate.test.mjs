import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { FilesystemMutateTool } from '../src/agent/tools/filesystem/mutate.mjs';
import { Agent } from '../src/agent/index.mjs';
import { runCli, EXIT } from '../src/cli/agent-cli.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-mutate-'));
  const workflow = join(base, 'workflow');
  const project = join(base, 'project');
  mkdirSync(workflow);
  mkdirSync(project);
  writeFileSync(join(project, 'notes.txt'), 'one\ntwo\n');
  const allowedRoots = [
    { name: 'workflow', path: workflow },
    { name: 'project', path: project },
  ];
  return { base, workflow, project, allowedRoots };
}

function input(paths, values = {}) {
  return {
    workflowDir: paths.workflow,
    allowedRoots: paths.allowedRoots,
    root: 'project',
    ...values,
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('filesystem_mutate previews by default and writes only with execute', async () => {
  const paths = fixture();
  try {
    const preview = await FilesystemMutateTool.execute(input(paths, {
      action: 'write', path: 'new.txt', content: 'hello\n',
    }));
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.executed, false);
    assert.equal(preview.files[0].beforeHash, null);
    assert.equal(existsSync(join(paths.project, 'new.txt')), false);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('filesystem_mutate edits atomically and detects expected hash conflicts', async () => {
  const paths = fixture();
  try {
    const file = join(paths.project, 'notes.txt');
    const before = readFileSync(file);
    const preview = await FilesystemMutateTool.execute(input(paths, {
      action: 'edit', path: 'notes.txt', old: 'one', new: 'ONE', expectedHash: sha(before),
    }));
    assert.equal(preview.files[0].afterHash, sha('ONE\ntwo\n'));
    assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n');

    const executed = await FilesystemMutateTool.execute(input(paths, {
      action: 'edit', path: 'notes.txt', old: 'one', new: 'ONE', expectedHash: sha(before), execute: true,
    }));
    assert.equal(executed.executed, true);
    assert.equal(readFileSync(file, 'utf8'), 'ONE\ntwo\n');

    const conflict = await FilesystemMutateTool.execute(input(paths, {
      action: 'write', path: 'notes.txt', content: 'bad', expectedHash: sha(before), execute: true,
    }));
    assert.equal(conflict.code, 'FILE_CONFLICT');
    assert.equal(readFileSync(file, 'utf8'), 'ONE\ntwo\n');
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('filesystem_mutate requires a unique edit and applies patches transactionally', async () => {
  const paths = fixture();
  try {
    await assert.rejects(
      () => FilesystemMutateTool.execute(input(paths, { action: 'edit', path: 'notes.txt', old: 'o', new: 'x' })),
      /exactly once/,
    );
    const patch = [
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    await assert.rejects(
      () => FilesystemMutateTool.execute(input(paths, { action: 'apply_patch', patch, execute: true })),
      /not found|context|outside/i,
    );
    assert.equal(readFileSync(join(paths.project, 'notes.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(existsSync(join(paths.project, 'missing.txt')), false);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
});

test('file CLI exposes preview, execute, stdin, and trusted-root reads', async () => {
  const paths = fixture();
  try {
    const preview = await runCli(['file', 'write', '--root', 'project', '--project-dir', paths.project, '--path', 'cli.txt', '--content', 'from cli', '--json'], { client: {} });
    assert.equal(preview.exitCode, EXIT.ok);
    assert.equal(preview.result.mode, 'preview');
    assert.equal(existsSync(join(paths.project, 'cli.txt')), false);
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
  const secondPaths = fixture();
  try {
    const executed = await runCli(['file', 'write', '--root', 'project', '--project-dir', secondPaths.project, '--path', 'cli.txt', '--content', '-', '--execute'], { client: {}, stdin: 'from stdin' });
    assert.equal(executed.result.mode, 'execute');
    assert.equal(readFileSync(join(secondPaths.project, 'cli.txt'), 'utf8'), 'from stdin');
    const read = await runCli(['file', 'read', '--root', 'project', '--project-dir', secondPaths.project, '--path', 'cli.txt'], { client: {} });
    assert.equal(read.result.content, 'from stdin');
  } finally {
    rmSync(secondPaths.base, { recursive: true, force: true });
  }
});

test('Agent previews file plans and executes them only after confirmation', async () => {
  const paths = fixture();
  const agent = new Agent({ workflowDir: paths.project, llmConfig: {} });
  const plan = {
    goal: 'write a project note',
    steps: [{
      id: 'step1',
      tool: 'filesystem_mutate',
      input: { action: 'write', root: 'workflow', path: 'agent.txt', content: 'confirmed' },
      description: 'Write the project note',
      expected_output: 'files',
    }],
  };
  try {
    await agent.init();
    const preview = await agent.prepareFileMutation('write the file', { plan });
    assert.equal(preview.needsConfirmation, true);
    assert.equal(existsSync(join(paths.project, 'agent.txt')), false);
    const result = await agent.runPrepared(preview.previewId);
    assert.equal(result.taskId, agent.taskId);
    assert.equal(readFileSync(join(paths.project, 'agent.txt'), 'utf8'), 'confirmed');
  } finally {
    await agent.cancel();
    rmSync(paths.base, { recursive: true, force: true });
  }
});
