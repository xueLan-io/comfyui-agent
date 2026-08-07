import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs, runCli, EXIT } from '../src/cli/agent-cli.mjs';
import { createPathContext, findPortableRoot } from '../src/runtime/path-context.mjs';

test('path context discovers portable ComfyUI and uses its workflow directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-path-'));
  try {
    await mkdir(join(root, 'python_embeded'), { recursive: true });
    await mkdir(join(root, 'ComfyUI', 'user', 'default', 'workflows'), { recursive: true });
    await writeFile(join(root, 'python_embeded', 'python.exe'), '');
    await writeFile(join(root, 'ComfyUI', 'main.py'), '');
    const context = createPathContext(join(root, 'ComfyUI-Agent'));
    assert.equal(findPortableRoot(join(root, 'ComfyUI-Agent')), root);
    assert.equal(context.portableRoot, root);
    assert.equal(context.workflowDir, join(root, 'ComfyUI', 'user', 'default', 'workflows'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI trusted roots use the discovered ComfyUI directory once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-cli-root-'));
  try {
    await mkdir(join(root, 'python_embeded'), { recursive: true });
    await mkdir(join(root, 'ComfyUI', 'input'), { recursive: true });
    await mkdir(join(root, 'ComfyUI', 'output'), { recursive: true });
    await mkdir(join(root, 'ComfyUI', 'temp'), { recursive: true });
    await mkdir(join(root, 'ComfyUI', 'user', 'default', 'workflows'), { recursive: true });
    await writeFile(join(root, 'python_embeded', 'python.exe'), '');
    await writeFile(join(root, 'ComfyUI', 'main.py'), '');
    const result = await runCli([
      'file', 'read', '--root', 'input', '--path', 'missing.png', '--json',
    ], { cwd: join(root, 'ComfyUI-Agent'), client: {} });
    assert.match(result.result.error, /not found|missing/i);
    assert.doesNotMatch(result.result.error, /ComfyUI\\ComfyUI/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI parses repeated media options and JSON assignments', () => {
  const parsed = parseArgs([
    'generate',
    '--workflow', 'demo.json',
    '--image', 'one.png',
    '--image', 'two.png',
    '--settings={"steps":24}',
    '--execute',
  ]);

  assert.deepEqual(parsed.positionals, ['generate']);
  assert.deepEqual(parsed.options.image, ['one.png', 'two.png']);
  assert.equal(parsed.options.settings, '{"steps":24}');
  assert.equal(parsed.options.execute, true);
});

test('workflow inspect stays read-only and uses the selected directory', async () => {
  const calls = [];
  const result = await runCli([
    'workflow', 'inspect',
    '--workflow', 'demo.json',
    '--workflow-dir', 'D:\\workflows',
    '--json',
  ], {
    client: {},
    inspect: {
      async execute(input) {
        calls.push(input);
        return { workflowName: input.workflowName, valid: true };
      },
    },
  });

  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.result.valid, true);
  assert.equal(calls[0].action, 'snapshot');
  assert.equal(calls[0].workflowName, 'demo.json');
  assert.equal(calls[0].workflowDir, 'D:\\workflows');
});

test('generate returns a preview without queueing unless execute is explicit', async () => {
  let prepared = 0;
  let executed = 0;
  const result = await runCli([
    'generate',
    '--workflow', 'demo.json',
    '--workflow-dir', 'D:\\workflows',
    '--positive', 'a red cat',
  ], {
    client: {},
    patch: { async execute() { return { ready: true, diff: [] }; } },
    direct: {
      async prepare(input) {
        prepared++;
        assert.equal(input.positive, 'a red cat');
        return { previewId: 'preview-1', issues: [] };
      },
      async run() {
        executed++;
        return { images: [{ filename: 'result.png' }] };
      },
    },
  });

  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.result.mode, 'preview');
  assert.equal(prepared, 1);
  assert.equal(executed, 0);
});

test('diagnose classifies an explicit ComfyUI error', async () => {
  const result = await runCli([
    'diagnose',
    '--error', 'queue temporarily unavailable',
    '--json',
  ], { client: {} });

  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.result.failure.type, 'comfyui_transient');
  assert.equal(result.result.failure.retryable, true);
});

test('doctor reports local runtime and independent ComfyUI health checks', async () => {
  const calls = [];
  const result = await runCli(['doctor', '--workflow-dir', 'D:\\workflows'], {
    client: {},
    system: {
      async execute(input) {
        calls.push(input.action);
        return input.action === 'status'
          ? { action: 'status', reachable: true, queue: { running: 0, pending: 0 } }
          : { action: 'device', reachable: true, device: { devices: [] } };
      },
    },
  });

  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.result.healthy, true);
  assert.equal(result.result.workflowDirectory, 'D:\\workflows');
  assert.deepEqual(calls.sort(), ['device', 'status']);
});

test('workflow errors produce a non-zero preflight exit code', async () => {
  const result = await runCli([
    'workflow', 'validate',
    '--workflow', 'missing.json',
    '--workflow-dir', 'D:\\workflows',
  ], {
    client: {},
    inspect: { async execute() { return { workflowName: 'missing.json', error: 'Workflow not found' }; } },
  });

  assert.equal(result.exitCode, EXIT.preflight);
  assert.match(result.result.error, /not found/i);
});

test('batch continues after an individual execution failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-cli-'));
  try {
    const promptsFile = join(dir, 'prompts.txt');
    await writeFile(promptsFile, 'first\nsecond\n');
    const result = await runCli([
      'batch',
      '--workflow', 'demo.json',
      '--workflow-dir', dir,
      '--prompts', promptsFile,
      '--execute',
    ], {
      client: {},
      patch: { async execute() { return { ready: true, diff: [] }; } },
      direct: {
        async prepare(input) { return { previewId: input.positive, issues: [] }; },
        async run(previewId) {
          if (previewId === 'first') throw new Error('queue temporarily unavailable');
          return { images: [{ filename: 'second.png' }] };
        },
      },
    });

    assert.equal(result.exitCode, 4);
    assert.equal(result.result.results.length, 2);
    assert.equal(result.result.results[0].failure.type, 'comfyui_transient');
    assert.equal(result.result.results[1].result.images[0].filename, 'second.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workflow list exposes discovered workflows without requiring ComfyUI', async () => {
  const result = await runCli([
    'workflow', 'list',
    '--workflow-dir', 'D:\\workflows',
  ], {
    client: {},
    comfy: { async discover(dir) { return [{ name: 'demo.json', dir }]; } },
  });

  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.result[0].name, 'demo.json');
  assert.equal(result.result[0].dir, 'D:\\workflows');
});

test('image inspect and model search delegate to their existing tools', async () => {
  const imageCalls = [];
  const modelCalls = [];
  const image = await runCli([
    'image', 'inspect',
    '--image', 'result.png',
    '--image-root', 'D:\\outputs',
  ], {
    client: {},
    image: { async execute(input) { imageCalls.push(input); return { image: { exists: true, width: 512 } }; } },
  });
  const models = await runCli([
    'model', 'search', '--query', 'flux', '--family', 'flux',
  ], {
    client: {},
    system: { async execute(input) { modelCalls.push(input); return { reachable: true, results: [] }; } },
  });

  assert.equal(image.exitCode, EXIT.ok);
  assert.equal(imageCalls[0].image.path, 'D:\\outputs\\result.png');
  assert.equal(models.exitCode, EXIT.ok);
  assert.deepEqual(modelCalls[0], { action: 'search_models', query: 'flux', kind: '', family: 'flux' });
});

test('queue clear previews by default and mutates only with execute', async () => {
  const calls = [];
  const client = {
    async queue() { return { queue_pending: [['1', 'pending-1']] }; },
    async queueDelete(ids) { calls.push(['delete', ids]); },
    async interrupt() { calls.push(['interrupt']); },
  };
  const preview = await runCli(['queue', 'clear'], { client });
  const executed = await runCli(['queue', 'clear', '--execute'], { client });

  assert.equal(preview.exitCode, EXIT.ok);
  assert.deepEqual(preview.result.pendingPromptIds, ['pending-1']);
  assert.equal(calls.length, 2);
  assert.equal(executed.result.cleared, 1);
  assert.deepEqual(calls, [['delete', ['pending-1']], ['interrupt']]);
});

test('prompt commands expose readiness and guard checks locally', async () => {
  const ready = await runCli([
    'prompt', 'check', '--text', 'a red cat', '--intent', 'generate',
  ], { client: {} });
  const guarded = await runCli([
    'prompt', 'guard',
    '--positive', 'a red cat, a red cat',
    '--negative', 'blurry',
    '--positive-budget', '3',
  ], { client: {} });

  assert.equal(ready.exitCode, EXIT.ok);
  assert.equal(ready.result.readiness, 'ready');
  assert.equal(guarded.exitCode, EXIT.ok);
  assert.doesNotMatch(guarded.result.positive, /a red cat, a red cat/);
  assert.equal(guarded.result.positiveTruncated, true);
});
