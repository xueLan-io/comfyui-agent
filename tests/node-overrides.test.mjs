import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkflowOverrides, extractCommonSettings, injectExecutionPrompts, selectExecutionOutputs, selectPreferredExecutionOutputs } from '../src/agent/tools/comfyui/node-overrides.mjs';

function promptFixture() {
  return {
    10: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 1,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
    20: {
      class_type: 'EmptyLatentImage',
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
  };
}

test('applies common generation settings to compatible active nodes', () => {
  const prompt = promptFixture();
  const result = applyWorkflowOverrides(prompt, { seed: 99, steps: 12, cfg: 4.5, width: 768, batch: 2 });

  assert.equal(prompt['10'].inputs.seed, 99);
  assert.equal(prompt['10'].inputs.steps, 12);
  assert.equal(prompt['10'].inputs.cfg, 4.5);
  assert.equal(prompt['20'].inputs.width, 768);
  assert.equal(prompt['20'].inputs.batch_size, 2);
  assert.equal(result.ignored.length, 0);
});

test('allows exact scalar node overrides but rejects linked and missing inputs', () => {
  const prompt = promptFixture();
  const result = applyWorkflowOverrides(prompt, {}, {
    10: { steps: '8', model: 'unsafe', missing: 3 },
  });

  assert.equal(prompt['10'].inputs.steps, 8);
  assert.deepEqual(prompt['10'].inputs.model, ['1', 0]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.ignored.length, 2);
});

test('extracts the current common controls for the node panel', () => {
  assert.deepEqual(extractCommonSettings(promptFixture()), {
    seed: 1,
    steps: 20,
    cfg: 7,
    sampler: 'euler',
    scheduler: 'normal',
    denoise: 1,
    width: 512,
    height: 512,
    batch: 1,
  });
});

test('follows conditional and resolution links to the effective control nodes', () => {
  const prompt = {
    1: { class_type: 'PrimitiveBoolean', inputs: { value: false } },
    2: { class_type: 'PrimitiveInt', inputs: { value: 12 } },
    3: { class_type: 'PrimitiveInt', inputs: { value: 36 } },
    4: { class_type: 'ImpactConditionalBranch', inputs: { cond: ['1', 0], tt_value: ['2', 0], ff_value: ['3', 0] } },
    5: { class_type: 'KSampler', inputs: { steps: ['4', 0] } },
    6: { class_type: 'TTResolutionSelector', inputs: { use_custom_resolution: false, resolution: '512x640 (4:5)', custom_width: 512, custom_height: 512 } },
    7: { class_type: 'EmptyLatentImage', inputs: { width: ['6', 0], height: ['6', 1], batch_size: 1 } },
  };

  applyWorkflowOverrides(prompt, { steps: 8, width: 768, height: 1024 });

  assert.equal(prompt['3'].inputs.value, 8);
  assert.equal(prompt['6'].inputs.use_custom_resolution, true);
  assert.equal(prompt['6'].inputs.custom_width, 768);
  assert.equal(prompt['6'].inputs.custom_height, 1024);
  assert.equal(extractCommonSettings(prompt).steps, 8);
  assert.equal(extractCommonSettings(prompt).width, 768);
});

test('injects positive and negative prompts only into profiled targets', () => {
  const prompt = {
    1: { class_type: 'easy promptList', inputs: { prompt_1: 'old one', prompt_2: 'old two', prompt_3: 'old three' } },
    2: { class_type: 'easy anythingIndexSwitch', inputs: { index: 0, value0: ['1', 1] } },
    3: { class_type: 'easy promptList', inputs: { prompt_1: 'other branch', prompt_2: 'stale' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
  };

  const applied = injectExecutionPrompts(prompt, { positive: 'new prompt', negative: 'new negative' }, {
    promptLists: [{ nodeId: '1', inputs: ['prompt_1', 'prompt_2', 'prompt_3'] }],
    positiveTargets: [],
    negativeTargets: [{ nodeId: '4', input: 'text' }],
    supportsNegative: true,
  });

  assert.deepEqual(prompt['1'].inputs, { prompt_1: 'new prompt', prompt_2: '', prompt_3: '' });
  assert.deepEqual(prompt['3'].inputs, { prompt_1: 'other branch', prompt_2: 'stale' });
  assert.equal(prompt['4'].inputs.text, 'new negative');
  assert.equal(applied.length, 4);
});

test('does not inject a normal negative prompt when the profile disables it', () => {
  const prompt = { 4: { class_type: 'CLIPTextEncode', inputs: { text: 'keep me' } } };
  injectExecutionPrompts(prompt, { positive: 'scene', negative: 'bad hands' }, {
    promptLists: [],
    positiveTargets: [],
    negativeTargets: [{ nodeId: '4', input: 'text' }],
    supportsNegative: false,
  });
  assert.equal(prompt['4'].inputs.text, 'keep me');
});

test('keeps only explicitly selected output nodes for one-output generation', () => {
  const prompt = {
    1: { class_type: 'KSampler', inputs: {} },
    2: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    3: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
  };

  assert.deepEqual(selectExecutionOutputs(prompt, ['2'], ['2', '3']), ['3']);
  assert.ok(prompt['2']);
  assert.equal(prompt['3'], undefined);
});

test('prefers a direct decoded image over reel and collage outputs', () => {
  const prompt = {
    1: { class_type: 'VAEDecode', inputs: { samples: ['9', 0] } },
    2: { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    3: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    4: { class_type: 'LayerUtility: ImageReelComposit', inputs: { reel_1: ['5', 0] } },
    5: { class_type: 'LayerUtility: ImageReel', inputs: { image1: ['1', 0] } },
  };

  assert.deepEqual(selectPreferredExecutionOutputs(prompt, ['2', '3']), ['3']);
});
