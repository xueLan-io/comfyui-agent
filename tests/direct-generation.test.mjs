import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directGenerationRequest } from '../src/runtime/generation-contract.mjs';
import { DirectService } from '../src/runtime/direct/direct-service.mjs';
import { validateDirectRequest } from '../src/runtime/direct/direct-validator.mjs';
import { ComfyExecutor } from '../src/runtime/executor/comfy-executor.mjs';

function workflow(overrides = {}) {
  return {
    modelType: 'anima',
    modelReady: true,
    promptProfile: {
      family: 'anima',
      format: 'tag_narrative',
      supportsNegative: true,
      promptLists: [],
      positiveTargets: [{ nodeId: '1', input: 'text' }],
      negativeTargets: [{ nodeId: '2', input: 'text' }],
    },
    editableNodes: [{ type: 'CLIPTextEncode' }],
    ...overrides,
  };
}

test('direct contract preserves prompt text and blocks prompt mutation', () => {
  const request = directGenerationRequest({
    workflowName: 'anima.json',
    positive: '  original, prompt  ',
    negative: 'bad anatomy',
    executionPolicy: { retry: true, evaluate: true, mutatePrompt: true },
  });

  assert.equal(request.source, 'direct');
  assert.equal(request.positive, '  original, prompt  ');
  assert.equal(request.negative, 'bad anatomy');
  assert.deepEqual(request.executionPolicy, { retry: true, evaluate: true, mutatePrompt: false });
  assert.ok(request.requestId);
});

test('direct request preserves project and session identifiers', () => {
  const request = directGenerationRequest({
    workflowName: 'anima.json',
    positive: 'a cat',
    negative: '',
    projectId: 'project-1',
    sessionId: 'session-1',
  });
  assert.equal(request.projectId, 'project-1');
  assert.equal(request.sessionId, 'session-1');
});

test('direct service prepares and executes without an agent runtime', async () => {
  const calls = [];
  const executor = {
    async inspect(workflowName, workflowDir) {
      calls.push(['inspect', workflowName, workflowDir]);
      return workflow();
    },
    async execute(request, options) {
      calls.push(['execute', request, options]);
      options.onProgress({ stage: 'queued', promptId: 'prompt_direct' });
      return { images: [{ filename: 'result.png' }], promptId: 'prompt_direct' };
    },
    async cancel() {
      calls.push(['cancel']);
      return { status: 'cancelled' };
    },
  };
  const service = new DirectService({ executor, workflowDir: 'workflows' });
  const preview = await service.prepare({
    workflowName: 'anima.json',
    positive: 'original prompt',
    negative: 'original negative',
    origin: 'prompt_library',
  });

  assert.equal(preview.source, 'direct');
  assert.equal(preview.positive, 'original prompt');
  assert.equal(preview.negative, 'original negative');
  assert.equal(preview.aiModified, false);
  assert.equal(service.getPreview(preview.previewId).requestId, preview.requestId);

  const progress = [];
  const result = await service.run(preview.previewId, { positive: 'edited explicitly' }, { onProgress: value => progress.push(value) });
  assert.equal(result.source, 'direct');
  assert.equal(result.origin, 'prompt_library');
  assert.equal(result.executionPolicy.evaluate, false);
  assert.equal(result.taskId, preview.requestId);
  assert.equal(calls.at(-1)[0], 'execute');
  assert.equal(calls.at(-1)[1].positive, 'edited explicitly');
  assert.equal(calls.at(-1)[1].negative, 'original negative');
  assert.equal(progress[0].promptId, 'prompt_direct');
  assert.equal(service.getPreview(preview.previewId), null);
});

test('direct service returns the unified media result for video output', async () => {
  const service = new DirectService({
    executor: {
      async inspect() { return workflow(); },
      async execute() { return { media: [{ filename: 'result.mp4' }] }; },
    },
  });
  const preview = await service.prepare({ workflowName: 'video.json', positive: 'a cat', negative: '' });
  const result = await service.run(preview.previewId);

  assert.equal(result.media.length, 1);
  assert.equal(result.images.length, 0);
  assert.equal(result.videos[0].filename, 'result.mp4');
});

test('direct service reports pending previews as busy', async () => {
  const service = new DirectService({
    executor: {
      async inspect() { return workflow(); },
      async execute() { return { images: [] }; },
      async cancel() {},
    },
  });

  assert.equal(service.isBusy, false);
  await service.prepare({ workflowName: 'anima.json', positive: 'a cat', negative: '' });
  assert.equal(service.isBusy, true);
});

test('direct service turns an empty executor result into a retryable output error', async () => {
  const service = new DirectService({
    executor: {
      async inspect() { return workflow(); },
      async execute() { return null; },
    },
  });

  const preview = await service.prepare({ workflowName: 'anima.json', positive: 'a cat', negative: '' });
  await assert.rejects(
    () => service.run(preview.previewId),
    error => error.failureType === 'empty_output' && error.message === 'No images in output',
  );
  assert.equal(service.getPreview(preview.previewId).status, 'prepared');
});

test('direct preview keeps its lifecycle status after execution failure', async () => {
  const service = new DirectService({
    executor: {
      async inspect() { return workflow(); },
      async execute() { throw Object.assign(new Error('submit unknown'), { failureType: 'submit_unknown', retryable: false }); },
    },
  });

  const preview = await service.prepare({ workflowName: 'anima.json', positive: 'a cat', negative: '' });
  await assert.rejects(() => service.run(preview.previewId), /submit unknown/);
  assert.equal(service.getPreview(preview.previewId).status, 'prepared');
});

test('direct service accepts media only from sandbox roots', async () => {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-direct-sandbox-'));
  const workflowDir = join(base, 'workflow');
  const projectDir = join(base, 'project');
  const outsidePath = join(base, 'outside.png');
  mkdirSync(workflowDir);
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'inside.png'), 'image');
  writeFileSync(outsidePath, 'outside');
  const executor = {
    async inspect() { return workflow(); },
    async execute() { return { images: [] }; },
  };
  const service = new DirectService({ executor, workflowDir });
  const sandboxInput = {
    workflowDir,
    allowedRoots: [{ name: 'project', path: projectDir }],
  };

  try {
    await assert.rejects(
      () => service.prepare({
        workflowName: 'anima.json',
        positive: 'a cat',
        negative: '',
        media: { images: [{ path: outsidePath }] },
      }, { sandboxInput }),
      /outside|allowed/i,
    );

    const preview = await service.prepare({
      workflowName: 'anima.json',
      positive: 'a cat',
      negative: '',
      media: { images: [{ path: join(projectDir, 'inside.png') }] },
    }, { sandboxInput });
    assert.ok(preview.previewId);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('direct validator blocks unsupported negative prompts without changing them', () => {
  const request = directGenerationRequest({ workflowName: 'flux.json', positive: 'a cat', negative: 'blurry' });
  const result = validateDirectRequest(request, workflow({
    modelType: 'flux',
    promptProfile: { supportsNegative: false, positiveTargets: [{ nodeId: '1', input: 'text' }] },
  }));

  assert.equal(result.valid, false);
  assert.ok(result.checks.some(check => check.type === 'negative_prompt' && check.level === 'error'));
  assert.equal(request.negative, 'blurry');
});

test('direct preflight exposes the shared diagnostic report', () => {
  const request = directGenerationRequest({ workflowName: 'anima.json', positive: 'a cat', negative: '' });
  const result = validateDirectRequest(request, workflow({
    modelReady: false,
    missingModels: [{ value: 'missing.safetensors', available: false }],
  }));

  assert.equal(result.valid, false);
  assert.equal(result.modelReady, false);
  assert.equal(result.errorCount, 1);
  assert.equal(result.issues[0].code, 'model_missing');
  assert.deepEqual(result.missingModels.map(item => item.value), ['missing.safetensors']);
});

test('shared Comfy executor passes an empty negative prompt without workflow fallback', async () => {
  let input;
  const executor = new ComfyExecutor({
    async execute(nextInput) {
      input = nextInput;
      return { images: [] };
    },
  });
  await executor.execute(directGenerationRequest({ workflowName: 'anima.json', positive: 'original', negative: '' }), { workflowDir: 'workflows' });

  assert.equal(input.compiledPrompt.positive, 'original');
  assert.equal(input.compiledPrompt.negative, '');
  assert.deepEqual(input.compiledPrompt.positivePrompts, ['original']);
});

test('direct service retries technical failures without changing the prompt', async () => {
  let attempts = 0;
  const executor = {
    async inspect() { return workflow(); },
    async execute(request) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('queue temporarily unavailable'), { failureType: 'comfyui_transient', retryable: true });
      return { images: [{ filename: 'result.png' }], promptId: 'prompt_direct', prompt: request.positive };
    },
  };
  const service = new DirectService({ executor, workflowDir: 'workflows' });
  const preview = await service.prepare({
    workflowName: 'anima.json',
    positive: '(masterpiece, best quality:1.2)',
    negative: '',
    executionPolicy: { retry: true, evaluate: true, mutatePrompt: false },
  });
  const result = await service.run(preview.previewId);

  assert.equal(attempts, 2);
  assert.equal(result.prompt, '(masterpiece, best quality:1.2)');
  assert.equal(result.executionPolicy.mutatePrompt, false);
});

test('direct service stops retrying when cancellation is requested during backoff', async () => {
  let attempts = 0;
  const controller = new AbortController();
  const service = new DirectService({
    executor: {
      async inspect() { return workflow(); },
      async execute() {
        attempts++;
        throw Object.assign(new Error('temporary failure'), { failureType: 'comfyui_transient', retryable: true });
      },
    },
  });
  const preview = await service.prepare({
    workflowName: 'anima.json',
    positive: 'a cat',
    negative: '',
    executionPolicy: { retry: true, evaluate: false, mutatePrompt: false },
  });

  const execution = service.run(preview.previewId, {}, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();

  await assert.rejects(execution, error => error.code === 'GENERATION_CANCELLED');
  assert.equal(attempts, 1);
});

test('direct service switches to an img2img workflow when a reference image is attached', async () => {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-direct-switch-'));
  const projectDir = join(base, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'ref.png'), 'image');
  const inspected = [];
  const executor = {
    async inspect(name) {
      inspected.push(name);
      return workflow({ capabilities: { modes: name.includes('img2img') ? ['img2img'] : ['txt2img'] } });
    },
    async discover() {
      return [
        { name: 'anima.json', capabilities: { modes: ['txt2img'] } },
        { name: 'anima-img2img.json', capabilities: { modes: ['img2img'] } },
      ];
    },
    async execute() { return { images: [] }; },
  };
  const service = new DirectService({ executor, workflowDir: 'workflows' });
  const sandboxInput = { workflowDir: 'workflows', allowedRoots: [{ name: 'project', path: projectDir }] };
  try {
    const preview = await service.prepare({
      workflowName: 'anima.json',
      positive: 'a cat',
      negative: '',
      media: { images: [{ path: join(projectDir, 'ref.png') }] },
    }, { sandboxInput });

    assert.equal(preview.workflow.name, 'anima-img2img.json');
    assert.ok(inspected.includes('anima-img2img.json'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('direct service switches to an inpaint workflow when a mask is attached', async () => {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-direct-switch-mask-'));
  const projectDir = join(base, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'mask.png'), 'mask');
  const executor = {
    async inspect(name) {
      return workflow({ capabilities: { modes: name.includes('inpaint') ? ['inpaint'] : ['txt2img'] } });
    },
    async discover() {
      return [
        { name: 'anima.json', capabilities: { modes: ['txt2img'] } },
        { name: 'anima-inpaint.json', capabilities: { modes: ['inpaint'] } },
      ];
    },
    async execute() { return { images: [] }; },
  };
  const service = new DirectService({ executor, workflowDir: 'workflows' });
  const sandboxInput = { workflowDir: 'workflows', allowedRoots: [{ name: 'project', path: projectDir }] };
  try {
    const preview = await service.prepare({
      workflowName: 'anima.json',
      positive: 'a cat',
      negative: '',
      media: { masks: [{ path: join(projectDir, 'mask.png') }] },
    }, { sandboxInput });

    assert.equal(preview.workflow.name, 'anima-inpaint.json');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('direct service keeps the requested workflow without media and skips discovery', async () => {
  let discovered = 0;
  const executor = {
    async inspect() { return workflow({ capabilities: { modes: ['txt2img'] } }); },
    async discover() {
      discovered++;
      return [];
    },
    async execute() { return { images: [] }; },
  };
  const service = new DirectService({ executor, workflowDir: 'workflows' });
  const preview = await service.prepare({ workflowName: 'anima.json', positive: 'a cat', negative: '' });

  assert.equal(preview.workflow.name, 'anima.json');
  assert.equal(discovered, 0);
});
