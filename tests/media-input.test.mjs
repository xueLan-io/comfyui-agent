import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { capReferenceImageResolution, injectInputMedia, referenceMediaInjected } from '../src/agent/tools/comfyui/node-overrides.mjs';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { resolveSandboxPath } from '../src/agent/security/sandbox.mjs';
import { attachMediaToPlan } from '../src/agent/runtime/planner.mjs';
import { buildAgentContext, contextToPrompt } from '../src/agent/schemas/context-schema.mjs';

function makePrompt() {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    '2': { class_type: 'LoadImageMask', inputs: { image: 'm.png', channel: 'alpha' } },
    '3': { class_type: 'LoadVideo', inputs: { video: '', frame_load_cap: 0 } },
  };
}

test('uploadMedia posts an image to /upload/image', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188' });
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url: String(url), method: opts.method });
    assert.ok(opts.body instanceof FormData);
    assert.equal(opts.body.get('image').name, 'photo.png');
    assert.equal(opts.body.get('type'), 'input');
    return new Response(JSON.stringify({ name: 'photo.png', subfolder: '', type: 'input' }), { status: 200 });
  };
  try {
    const ref = await client.uploadMedia('image', 'photo.png', Buffer.from('abc'), { type: 'input' });
    assert.equal(ref.name, 'photo.png');
    assert.equal(seen[0].url, 'http://127.0.0.1:8188/upload/image');
    assert.equal(seen[0].method, 'POST');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uploadMedia mask with originalRef targets /upload/mask', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188' });
  const originalFetch = global.fetch;
  let url = '';
  global.fetch = async (fetchUrl, opts) => {
    url = String(fetchUrl);
    assert.equal(opts.body.get('original_ref'), JSON.stringify({ filename: 'a.png', subfolder: '', type: 'input' }));
    return new Response(JSON.stringify({ name: 'm.png', subfolder: '', type: 'input' }), { status: 200 });
  };
  try {
    const ref = await client.uploadMedia('mask', 'm.png', Buffer.from('m'), {
      type: 'input',
      originalRef: { filename: 'a.png', subfolder: '', type: 'input' },
    });
    assert.equal(ref.name, 'm.png');
    assert.equal(url, 'http://127.0.0.1:8188/upload/mask');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uploadMedia mask without originalRef falls back to /upload/image', async () => {
  const client = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188' });
  const originalFetch = global.fetch;
  let url = '';
  global.fetch = async fetchUrl => {
    url = String(fetchUrl);
    return new Response(JSON.stringify({ name: 'm.png', subfolder: '', type: 'input' }), { status: 200 });
  };
  try {
    await client.uploadMedia('mask', 'm.png', Buffer.from('m'), { type: 'input' });
    assert.equal(url, 'http://127.0.0.1:8188/upload/image');
  } finally {
    global.fetch = originalFetch;
  }
});

test('injectInputMedia assigns images to LoadImage nodes', () => {
  const prompt = makePrompt();
  const report = injectInputMedia(prompt, { images: [{ name: 'cat.png', subfolder: 'sub', type: 'input' }] });

  assert.equal(prompt['1'].inputs.image, 'sub/cat.png');
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].source, 'images');
});

test('injectInputMedia assigns masks to LoadImageMask nodes', () => {
  const prompt = makePrompt();
  const report = injectInputMedia(prompt, { masks: [{ name: 'mask.png', subfolder: '', type: 'input' }] });

  assert.equal(prompt['2'].inputs.image, 'mask.png');
  assert.equal(report.applied[0].source, 'masks');
});

test('injectInputMedia falls back to an unused LoadImage for masks', () => {
  const prompt = {
    '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
  };
  const report = injectInputMedia(prompt, { masks: [{ name: 'm.png' }] });

  assert.equal(prompt['1'].inputs.image, 'm.png');
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].source, 'masks');
});

test('injectInputMedia ignores masks when no free loader remains', () => {
  const prompt = {
    '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
  };
  const report = injectInputMedia(prompt, { images: [{ name: 'a.png' }], masks: [{ name: 'm.png' }] });

  assert.equal(prompt['1'].inputs.image, 'a.png');
  assert.equal(report.ignored.some(i => i.kind === 'masks'), true);
});

test('injectInputMedia assigns videos to video loader inputs', () => {
  const prompt = makePrompt();
  const report = injectInputMedia(prompt, { videos: [{ name: 'clip.mp4' }] });

  assert.equal(prompt['3'].inputs.video, 'input/clip.mp4');
  assert.equal(report.applied[0].source, 'videos');
});

test('injectInputMedia skips linked inputs and reports ignored', () => {
  const prompt = {
    '1': { class_type: 'LoadImage', inputs: { image: ['5', 0] } },
  };
  const report = injectInputMedia(prompt, { images: [{ name: 'a.png' }] });

  assert.deepEqual(report.applied, []);
  assert.equal(report.ignored.length, 1);
  assert.equal(report.ignored[0].reason, 'no_unlinked_image_input');
});

test('injectInputMedia reports when no loader node exists', () => {
  const prompt = { '1': { class_type: 'KSampler', inputs: { seed: 1 } } };
  const report = injectInputMedia(prompt, { images: [{ name: 'a.png' }] });

  assert.equal(report.ignored[0].reason, 'no_load_image_node');
});

test('caps img2img reference resolution before VAE encoding', () => {
  const prompt = {
    5: { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
  };
  const report = capReferenceImageResolution(prompt, { ImageScaleToMaxDimension: {} });

  assert.equal(report.applied, 1);
  assert.deepEqual(prompt['6'].inputs.pixels, ['7', 0]);
  assert.deepEqual(prompt['7'], {
    class_type: 'ImageScaleToMaxDimension',
    inputs: { image: ['5', 0], upscale_method: 'lanczos', largest_size: 1024 },
  });
});

test('referenceMediaInjected does not fail when at least one upload connected', () => {
  assert.equal(referenceMediaInjected({ total: 2 }, { applied: [{ nodeId: '1' }], ignored: [{ kind: 'masks' }] }), true);
  assert.equal(referenceMediaInjected({ total: 1 }, { applied: [{ nodeId: '1' }], ignored: [] }), true);
});

test('referenceMediaInjected fails only when uploads exist but none connected', () => {
  assert.equal(referenceMediaInjected({ total: 1 }, { applied: [], ignored: [{ kind: 'images' }] }), false);
  assert.equal(referenceMediaInjected({ total: 0 }, { applied: [], ignored: [] }), true);
});

test('attachMediaToPlan injects media into comfyui steps only', () => {
  const plan = {
    steps: [
      { id: 'step1', tool: 'comfyui', input: {} },
      { id: 'step2', tool: 'prompt_enhance', input: {} },
    ],
  };

  attachMediaToPlan(plan, { images: [{ path: 'x.png' }], videos: ['clip.mp4'], masks: [] });

  assert.deepEqual(plan.steps[0].input.images, [{ path: 'x.png' }]);
  assert.deepEqual(plan.steps[0].input.videos, ['clip.mp4']);
  assert.ok(!plan.steps[0].input.masks);
  assert.ok(!plan.steps[1].input.images);
});

test('attachMediaToPlan overwrites fabricated step media with real media', () => {
  const plan = {
    steps: [
      { id: 'step1', tool: 'comfyui', input: { images: [{ path: '/fake/generated.png' }] } },
      { id: 'step2', tool: 'prompt_enhance', input: { images: [{ path: '/fake/hint.png' }] } },
    ],
  };

  attachMediaToPlan(plan, { images: [{ path: 'x.png' }], videos: ['clip.mp4'], masks: [] });

  assert.deepEqual(plan.steps[0].input.images, [{ path: 'x.png' }]);
  assert.deepEqual(plan.steps[0].input.videos, ['clip.mp4']);
  assert.ok(!plan.steps[0].input.masks);
  assert.deepEqual(plan.steps[1].input.images, [{ path: '/fake/hint.png' }]);
});

test('attachMediaToPlan removes fabricated step media when no real media exists', () => {
  const plan = {
    steps: [
      { id: 'step1', tool: 'comfyui', input: { images: [{ path: '/fake/generated.png' }], videos: ['/fake/clip.mp4'] } },
    ],
  };

  attachMediaToPlan(plan, { images: [], masks: [], videos: [] });

  assert.ok(!('images' in plan.steps[0].input));
  assert.ok(!('videos' in plan.steps[0].input));
});

test('_uploadMedia reads files, uploads, and links mask originalRef', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfy-agent-media-'));
  const imgPath = join(dir, 'a.png');
  writeFileSync(imgPath, 'pngdata');

  const uploads = [];
  ComfyUITool.setClient({
    uploadMedia: async (kind, name, _data, opts) => {
      uploads.push({ kind, name, opts });
      return { name, subfolder: '', type: 'input' };
    },
  });

  try {
    const result = await ComfyUITool._uploadMedia({
      images: [{ path: imgPath }],
      masks: [{ path: imgPath, name: 'm.png' }],
    });

    assert.equal(result.total, 2);
    assert.equal(uploads[0].kind, 'image');
    assert.equal(uploads[1].kind, 'mask');
    assert.deepEqual(uploads[1].opts.originalRef, { filename: 'a.png', subfolder: '', type: 'input' });
  } finally {
    ComfyUITool.setClient(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('_uploadMedia throws on missing file', async () => {
  ComfyUITool.setClient({ uploadMedia: async () => ({ name: 'x.png', subfolder: '', type: 'input' }) });
  try {
    await assert.rejects(
      () => ComfyUITool._uploadMedia({ images: [{ path: join(tmpdir(), 'definitely-missing.png') }] }),
      /Media file not found/,
    );
  } finally {
    ComfyUITool.setClient(null);
  }
});

test('_uploadMedia rechecks media paths against the sandbox context', async () => {
  const base = mkdtempSync(join(tmpdir(), 'comfy-agent-media-sandbox-'));
  const workflowDir = join(base, 'workflow');
  const projectDir = join(base, 'project');
  const outsidePath = join(base, 'outside.png');
  mkdirSync(workflowDir);
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'inside.png'), 'inside');
  writeFileSync(outsidePath, 'outside');
  ComfyUITool.setClient({ uploadMedia: async (kind, name) => ({ name, subfolder: '', type: 'input' }) });
  const sandboxInput = { workflowDir, allowedRoots: [{ name: 'project', path: projectDir }] };

  try {
    await assert.rejects(
      () => ComfyUITool._uploadMedia({
        images: [{ path: outsidePath }],
        sandboxInput,
      }),
      /outside|allowed/i,
    );
    const result = await ComfyUITool._uploadMedia({
      images: [{ path: resolveSandboxPath(sandboxInput, 'inside.png', { root: 'project' }) }],
      sandboxInput,
    });
    assert.equal(result.total, 1);
  } finally {
    ComfyUITool.setClient(null);
    rmSync(base, { recursive: true, force: true });
  }
});

test('contextToPrompt mentions attached media', () => {
  const ctx = buildAgentContext('根据这张图改风格', {
    attachedMedia: { images: [{ name: 'a.png' }], videos: ['clip.mp4'] },
  });

  const prompt = contextToPrompt(ctx);
  assert.ok(prompt.includes('User attached media: 1 image(s): a.png; 1 video(s): clip.mp4'));
});
