import { describe, expect, it } from 'vitest';

import { loadConfig, ConfigError } from '../../src/agent/core-loop/config/env.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe('loadConfig', () => {
  it('defaults to mock provider, dry-run on, and the local ComfyUI server', () => {
    const config = loadConfig(env({}));
    expect(config.model.provider).toBe('mock');
    expect(config.guardrails.dryRun).toBe(true);
    expect(config.comfy.baseUrl).toBe('http://127.0.0.1:8188');
    expect(config.guardrails.maxSteps).toBe(12);
    expect(config.guardrails.nodeAllowlist).toEqual([]);
  });

  it('parses boolean spellings', () => {
    // Absent falls back to the default (true); explicit non-truthy strings are false.
    expect(loadConfig(env({ AGENT_DRY_RUN: 'false' })).guardrails.dryRun).toBe(false);
    expect(loadConfig(env({ AGENT_DRY_RUN: 'no' })).guardrails.dryRun).toBe(false);
    expect(loadConfig(env({ AGENT_DRY_RUN: '1' })).guardrails.dryRun).toBe(true);
    expect(loadConfig(env({})).guardrails.dryRun).toBe(true);
  });

  it('parses the node allowlist and trims entries', () => {
    const config = loadConfig(env({ AGENT_NODE_ALLOWLIST: ' KSampler , SaveImage ,,' }));
    expect(config.guardrails.nodeAllowlist).toEqual(['KSampler', 'SaveImage']);
  });

  it('strips trailing slashes from the ComfyUI base URL', () => {
    expect(loadConfig(env({ COMFY_BASE_URL: 'http://x.test:8188///' })).comfy.baseUrl).toBe(
      'http://x.test:8188',
    );
  });

  it('fails loudly when the openai provider has no key', () => {
    expect(() =>
      loadConfig(env({ MODEL_PROVIDER: 'openai', MODEL_API_KEY: '' })),
    ).toThrow(ConfigError);
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig(env({ MODEL_PROVIDER: 'gemini' }))).toThrow(ConfigError);
  });
});
