import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { AppConfig } from '../../src/agent/core-loop/config/env.js';
import type { ObjectInfoResponse } from '../../src/agent/core-loop/comfy/client.js';
import type { ExecutionOutcome } from '../../src/agent/core-loop/comfy/ws.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The recorded /object_info snapshot of a small SD1.5-style install. */
export function loadFixture(): ObjectInfoResponse {
  return JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'object_info.sd15.json'), 'utf8'),
  ) as ObjectInfoResponse;
}

/**
 * Deterministic test configuration — no environment variables involved.
 * Section overrides deep-merge over safe defaults.
 */
export function testConfig(overrides: {
  model?: Partial<AppConfig['model']>;
  comfy?: Partial<AppConfig['comfy']>;
  guardrails?: Partial<AppConfig['guardrails']>;
  observability?: Partial<AppConfig['observability']>;
} = {}): AppConfig {
  return {
    model: {
      provider: 'mock',
      baseUrl: 'http://model.invalid/v1',
      apiKey: '',
      name: 'mock',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 30_000,
      ...overrides.model,
    },
    comfy: {
      baseUrl: 'http://comfy.test:8188',
      apiKey: '',
      ...overrides.comfy,
    },
    guardrails: {
      dryRun: true,
      maxSteps: 12,
      timeoutMs: 60_000,
      nodeAllowlist: [],
      ...overrides.guardrails,
    },
    observability: {
      logLevel: 'silent',
      traceDir: 'traces-test',
      ...overrides.observability,
    },
  };
}

/**
 * A fetch impl that answers the ComfyUI routes from the fixture, so the real
 * ComfyClient code path runs with no server. Unknown routes fail loudly — a
 * silent 404 would make tests pass for the wrong reason.
 */
export function fixtureFetch(): typeof fetch {
  const objectInfo = loadFixture();
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();

    const jsonResponse = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (method === 'GET' && path === '/object_info') return jsonResponse(objectInfo);
    if (method === 'GET' && path === '/system_stats') {
      return jsonResponse({
        system: { comfyui_version: '0.3.99-test', python_version: '3.12.7', os: 'test' },
        devices: [
          {
            name: 'TestGPU',
            type: 'cuda',
            vram_total: 24 * 1024 ** 3,
            vram_free: 16 * 1024 ** 3,
          },
        ],
      });
    }
    if (method === 'GET' && path === '/queue') {
      return jsonResponse({ queue_running: [], queue_pending: [] });
    }
    if (method === 'GET' && path === '/models/checkpoints') {
      return jsonResponse([
        'v1-5-pruned-emaonly.safetensors',
        'sd_xl_base_1.0.safetensors',
        'dreamshaper_8.safetensors',
      ]);
    }
    if (method === 'POST' && path === '/prompt') {
      return jsonResponse({ prompt_id: 'prompt-test-123', number: 1, node_errors: {} });
    }
    if (method === 'GET' && path === '/history/prompt-test-123') {
      return jsonResponse({
        'prompt-test-123': {
          outputs: {
            '7': {
              images: [{ filename: 'comfyagent_00001_.png', subfolder: '', type: 'output' }],
            },
          },
          status: { status_str: 'success', completed: true },
        },
      });
    }

    throw new Error(`fixtureFetch: unhandled route ${method} ${path}`);
  }) as typeof fetch;
}

/** A socket whose jobs finish instantly and produce one image from node 7. */
export function fakeOutcome(promptId: string): ExecutionOutcome {
  return {
    promptId,
    status: 'success',
    outputs: {
      '7': { images: [{ filename: 'comfyagent_00001_.png', subfolder: '', type: 'output' }] },
    },
    cachedNodes: [],
    durationMs: 1234,
  };
}

export const FAKE_SOCKET = {
  async waitForResult(promptId: string): Promise<ExecutionOutcome> {
    return fakeOutcome(promptId);
  },
  close(): void {},
} as never;
