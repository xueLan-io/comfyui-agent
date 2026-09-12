import { describe, expect, it } from 'vitest';

import { ObjectInfoIndex, parseInputSpec } from '../../src/agent/core-loop/comfy/objectInfo.js';
import { loadFixture } from './helpers.js';

const index = new ObjectInfoIndex(loadFixture());

describe('parseInputSpec', () => {
  it('parses a closed enum with a default', () => {
    const input = parseInputSpec(
      'sampler_name',
      [['euler', 'heun'], { default: 'euler' }],
      true,
    );
    expect(input.type).toBe('ENUM');
    expect(input.values).toEqual(['euler', 'heun']);
    expect(input.default).toBe('euler');
    expect(input.required).toBe(true);
  });

  it('parses an INT with range', () => {
    const input = parseInputSpec('width', ['INT', { default: 512, min: 16, max: 16384 }], true);
    expect(input.type).toBe('INT');
    expect(input.min).toBe(16);
    expect(input.max).toBe(16384);
    expect(input.default).toBe(512);
  });

  it('parses a multiline STRING', () => {
    const input = parseInputSpec('text', ['STRING', { multiline: true, default: '' }], true);
    expect(input.type).toBe('STRING');
    expect(input.multiline).toBe(true);
  });

  it('parses a COMBO whose values live in options', () => {
    const input = parseInputSpec(
      'mode',
      ['COMBO', { options: ['a', 'b'] }],
      false,
    );
    expect(input.type).toBe('ENUM');
    expect(input.values).toEqual(['a', 'b']);
  });

  it('truncates very long enum lists but keeps the default visible', () => {
    const many = Array.from({ length: 100 }, (_, i) => `model_${i}.safetensors`);
    many[97] = 'the_default.safetensors';
    const input = parseInputSpec('ckpt', [many, { default: 'the_default.safetensors' }], true);
    expect(input.valuesTruncated).toBe(true);
    expect((input.values ?? []).length).toBeLessThan(100);
    expect(input.values).toContain('the_default.safetensors');
    expect(input.totalValues).toBe(100);
  });

  it('handles the dict form used by some custom nodes', () => {
    const input = parseInputSpec('weird', { type: 'CUSTOM_TYPE' }, true);
    expect(input.type).toBe('CUSTOM_TYPE');
  });
});

describe('ObjectInfoIndex.search', () => {
  it('finds a checkpoint loader and ranks it first', () => {
    const hits = index.search('checkpoint loader');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.class_type).toBe('CheckpointLoaderSimple');
  });

  it('returns compact hits without schemas', () => {
    const hits = index.search('sampler');
    for (const hit of hits) {
      expect(Object.keys(hit)).not.toContain('required');
      expect(hit).toHaveProperty('class_type');
      expect(hit).toHaveProperty('output_types');
    }
  });

  it('finds nodes by output type keywords', () => {
    const hits = index.search('latent');
    expect(hits.map((h) => h.class_type)).toContain('EmptyLatentImage');
  });

  it('returns nothing for gibberish', () => {
    expect(index.search('zzzqqq')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(index.search('image', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('ObjectInfoIndex.getSchema', () => {
  it('projects the full schema for one node', () => {
    const schema = index.getSchema('KSampler');
    expect(schema?.class_type).toBe('KSampler');
    expect(schema?.output_types).toEqual(['LATENT']);
    expect(schema?.output_node).toBe(false);

    const byName = new Map(schema?.required.map((r) => [r.name, r]));
    expect(byName.get('sampler_name')?.values).toContain('euler');
    expect(byName.get('seed')?.type).toBe('INT');
    expect(byName.get('cfg')?.type).toBe('FLOAT');
  });

  it('marks output nodes', () => {
    expect(index.getSchema('SaveImage')?.output_node).toBe(true);
    expect(index.getSchema('KSampler')?.output_node).toBe(false);
  });

  it('returns undefined for unknown classes so callers can produce did-you-mean', () => {
    expect(index.getSchema('Nope')).toBeUndefined();
  });
});

describe('ObjectInfoIndex.enumValues', () => {
  it('returns real server values — the poka-yoke primitive', () => {
    expect(index.enumValues('KSampler', 'sampler_name')).toContain('dpmpp_2m');
    expect(index.enumValues('CheckpointLoaderSimple', 'ckpt_name')).toContain(
      'v1-5-pruned-emaonly.safetensors',
    );
  });

  it('returns undefined for non-enum or unknown inputs', () => {
    expect(index.enumValues('KSampler', 'nope')).toBeUndefined();
  });
});
