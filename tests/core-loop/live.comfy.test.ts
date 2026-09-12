import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/core-loop/core/agent.js';
import { createChatModel } from '../../src/agent/core-loop/model/provider.js';
import { createRuntime } from '../../src/agent/core-loop/runtime.js';
import { AutoApproveGate } from '../../src/agent/core-loop/guardrails/approval.js';
import { loadConfig } from '../../src/agent/core-loop/config/env.js';

/**
 * Live integration against a real ComfyUI server.
 *
 * Gated behind COMFY_LIVE=1 so the default suite stays offline. Requires:
 *   - ComfyUI running at COMFY_BASE_URL (default http://127.0.0.1:8188)
 *   - MODEL_PROVIDER=openai + MODEL_API_KEY + MODEL_NAME (a real model)
 *   - AGENT_DRY_RUN=false (this test sets dryRun=false itself)
 *   - at least one checkpoint installed
 */
const LIVE = process.env['COMFY_LIVE'] === '1';
const d = LIVE ? describe : describe.skip;

d('live ComfyUI integration', () => {
  it('generates an image from a prompt, end to end', { timeout: 600_000 }, async () => {
    const config = loadConfig();
    const runtime = createRuntime({
      config,
      overrides: { approvalGate: new AutoApproveGate() },
    });

    const agent = new Agent({
      model: createChatModel({ config: config.model }),
      registry: runtime.registry,
      toolContext: runtime.toolContext('live-test', () => {}),
      config: {
        maxSteps: 14,
        timeoutMs: 540_000,
      },
    });

    const result = await agent.run({
      input: process.env['COMFY_LIVE_PROMPT'] ?? 'a red fox in snow, cinematic, 512x512',
      runId: 'live-integration',
    });

    expect(result.status).toBe('completed');
    expect(result.workflows.at(-1)?.validation?.valid).toBe(true);
    expect(result.promptIds.length).toBeGreaterThan(0);
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.filename).toBeTruthy();
  });
});
