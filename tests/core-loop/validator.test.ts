import { describe, expect, it } from 'vitest';

import { ObjectInfoIndex } from '../../src/agent/core-loop/comfy/objectInfo.js';
import {
  detectCycle,
  formatValidationResult,
  reachableFrom,
  validateWorkflow,
} from '../../src/agent/core-loop/comfy/validator.js';
import type { ApiWorkflow } from '../../src/agent/core-loop/comfy/workflow.js';
import { loadFixture } from './helpers.js';

const catalog = new ObjectInfoIndex(loadFixture());

/** The canonical valid text-to-image graph used across these tests. */
function validWorkflow(): ApiWorkflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a fox', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: 42,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        denoise: 1,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'comfyagent' } },
  };
}

describe('validateWorkflow — happy path', () => {
  it('accepts the canonical text-to-image graph with no findings', () => {
    const result = validateWorkflow(validWorkflow(), catalog);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.outputNodes).toEqual(['7']);
    expect(result.reachable).toContain('1');
    expect(result.reachable).toContain('7');
  });

  it('reports VALID with the reachable count', () => {
    const text = formatValidationResult(validateWorkflow(validWorkflow(), catalog));
    expect(text).toMatch(/^VALID/);
    expect(text).toContain('output node');
  });
});

describe('validateWorkflow — node existence', () => {
  it('rejects an unknown class_type', () => {
    const wf = validWorkflow();
    wf['6'] = { class_type: 'VAEDecodee', inputs: { samples: ['5', 0], vae: ['1', 2] } };
    const result = validateWorkflow(wf, catalog);
    expect(result.valid).toBe(false);
    const code = result.errors.find((e) => e.code === 'UNKNOWN_NODE');
    expect(code?.node).toBe('6');
  });

  it('honours the node allowlist', () => {
    const result = validateWorkflow(validWorkflow(), catalog, {
      nodeAllowlist: ['KSampler', 'SaveImage'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.code === 'NODE_NOT_ALLOWED').length).toBeGreaterThan(0);
  });
});

describe('validateWorkflow — inputs and links', () => {
  it('rejects a missing required input without a default', () => {
    const wf = validWorkflow();
    // CLIPTextEncode requires both text and clip.
    delete (wf['2'] as { inputs: Record<string, unknown> }).inputs.clip;
    const result = validateWorkflow(wf, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED_INPUT' && e.node === '2')).toBe(true);
  });

  it('warns (not errors) when a defaulted required input is omitted', () => {
    const wf = validWorkflow();
    // KSampler.seed has default 0 in the fixture.
    delete (wf['5'] as { inputs: Record<string, unknown> }).inputs.seed;
    const result = validateWorkflow(wf, catalog);
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED_INPUT')).toBe(false);
    expect(result.warnings.some((e) => e.code === 'REQUIRED_INPUT_OMITTED')).toBe(true);
  });

  it('warns about inputs the node does not declare', () => {
    const wf = validWorkflow();
    (wf['4'] as { inputs: Record<string, unknown> }).inputs.width_extra = 10;
    const result = validateWorkflow(wf, catalog);
    expect(result.warnings.some((e) => e.code === 'UNKNOWN_INPUT' && e.input === 'width_extra')).toBe(true);
  });

  it('rejects a link to a node that is not in the workflow', () => {
    const wf = validWorkflow();
    delete wf['4'];
    const result = validateWorkflow(wf, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'LINK_TARGET_MISSING')).toBe(true);
  });

  it('rejects an out-of-range output slot with a helpful hint', () => {
    const wf = validWorkflow();
    (wf['2'] as { inputs: Record<string, unknown> }).inputs.clip = ['1', 9];
    const result = validateWorkflow(wf, catalog);
    const finding = result.errors.find((e) => e.code === 'LINK_SLOT_OUT_OF_RANGE');
    expect(finding).toBeDefined();
    expect(finding?.hint).toContain('0..2');
  });

  it('rejects a type mismatch (MODEL into a CLIP input)', () => {
    const wf = validWorkflow();
    (wf['2'] as { inputs: Record<string, unknown> }).inputs.clip = ['1', 0]; // MODEL, not CLIP
    const result = validateWorkflow(wf, catalog);
    expect(result.errors.some((e) => e.code === 'LINK_TYPE_MISMATCH')).toBe(true);
  });
});

describe('validateWorkflow — structure', () => {
  it('rejects a cycle', () => {
    const wf: ApiWorkflow = {
      // LoadImage→LoadImage is impossible; craft a two-node cycle via nodes
      // with matching types: CLIPTextEncode takes CLIP but produces CONDITIONING,
      // so use two image-capable nodes: LoadImage outputs IMAGE/MASK — but no
      // IMAGE-consuming non-output node exists in the fixture besides SaveImage.
      // A cycle is checked structurally before types, so wire SaveImage back
      // into LoadImage's non-existent input — instead, use the structural
      // detector directly below for a pure cycle and keep this end-to-end check
      // to a self-link, which is also structural.
    };
    void wf;
    const cyclic: ApiWorkflow = {
      '1': { class_type: 'Note', inputs: { text: 'a' } },
    };
    void cyclic;
    // Pure structural cycle: 1 → 2 → 1. detectCycle operates on ids only.
    const fake: ApiWorkflow = {
      '1': { class_type: 'Note', inputs: { text: ['2', 0] } },
      '2': { class_type: 'Note', inputs: { text: ['1', 0] } },
    };
    const cycle = detectCycle(fake);
    expect(cycle).toBeDefined();
    expect(cycle).toEqual(['1', '2', '1']);

    // validateWorkflow also runs the detector (types are unknown for Note, so
    // link checks pass) — the gate must refuse it.
    const result = validateWorkflow(fake, catalog);
    expect(result.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });

  it('rejects a workflow with no output node', () => {
    const wf = validWorkflow();
    delete wf['7'];
    const result = validateWorkflow(wf, catalog);
    expect(result.errors.some((e) => e.code === 'NO_OUTPUT_NODE')).toBe(true);
  });

  it('warns about nodes unreachable from any output node', () => {
    const wf = validWorkflow();
    // An orphan latent generator nothing consumes.
    wf['9'] = { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } };
    const result = validateWorkflow(wf, catalog);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((e) => e.code === 'NODE_UNREACHABLE' && e.node === '9')).toBe(true);
  });

  it('rejects an empty workflow', () => {
    const result = validateWorkflow({}, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('EMPTY_WORKFLOW');
  });

  it('computes reachability from output nodes', () => {
    const reachable = reachableFrom(validWorkflow(), ['7']);
    expect(reachable).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
});
