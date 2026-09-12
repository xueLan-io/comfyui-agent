import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/core-loop/core/agent.js';
import type { RunEvent } from '../../src/agent/core-loop/core/events.js';
import { createChatModel } from '../../src/agent/core-loop/model/provider.js';
import { createRuntime } from '../../src/agent/core-loop/runtime.js';
import { AutoApproveGate } from '../../src/agent/core-loop/guardrails/approval.js';
import { FAKE_SOCKET, fixtureFetch, testConfig } from './helpers.js';

/**
 * The offline golden test.
 *
 * Drives the REAL agent loop, REAL tool registry, REAL validator, and REAL
 * ComfyClient over a fixture-backed fetch — no ComfyUI server, no API key, no
 * network. The mock model follows the reference discovery→build→validate→submit
 * plan, exactly the sequence a real model is prompted to follow.
 */

function makeAgent(options: { dryRun: boolean; autoApprove?: boolean }) {
  const config = testConfig({
    guardrails: { dryRun: options.dryRun },
  });
  const runtime = createRuntime({
    config,
    overrides: {
      fetchImpl: fixtureFetch(),
      socket: FAKE_SOCKET,
      approvalGate: options.autoApprove ? new AutoApproveGate() : undefined,
      clientId: 'test-client',
    },
  });

  const events: RunEvent[] = [];
  const agent = new Agent({
    model: createChatModel({ config: config.model }),
    registry: runtime.registry,
    toolContext: runtime.toolContext('test-run', () => {}),
    config: { maxSteps: 12, timeoutMs: 30_000 },
    listeners: [(event) => events.push(event)],
  });
  return { agent, runtime, events };
}

describe('offline end-to-end: text-to-image golden path', () => {
  it('discovers nodes, builds a valid workflow, and stops at the dry-run gate', async () => {
    const { agent, events } = makeAgent({ dryRun: true });

    const result = await agent.run({
      input: 'a red fox in snow, cinematic, 1024x1024',
      runId: 'golden-dry',
    });

    expect(result.status).toBe('dry_run');
    expect(result.steps).toBeLessThanOrEqual(12);

    // The workflow was built AND validated as passing.
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.validation?.valid).toBe(true);

    // Dry-run simulated the submission and produced no images.
    expect(result.promptIds).toEqual(['dryrun_wf_1']);
    expect(result.images).toEqual([]);

    // The loop exercised the intended sequence, in order of first appearance.
    const toolOrder = events
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e.type === 'tool_call' ? e.call.name : ''));
    const firstOf = (name: string) => toolOrder.indexOf(name);
    expect(firstOf('server_status')).toBe(0);
    expect(firstOf('search_node_types')).toBeGreaterThan(firstOf('server_status'));
    expect(firstOf('get_node_schema')).toBeGreaterThan(firstOf('search_node_types'));
    expect(firstOf('build_workflow')).toBeGreaterThan(firstOf('get_node_schema'));
    expect(firstOf('validate_workflow')).toBeGreaterThan(firstOf('build_workflow'));
    expect(firstOf('submit_workflow')).toBeGreaterThan(firstOf('validate_workflow'));
    expect(firstOf('wait_for_result')).toBeGreaterThan(firstOf('submit_workflow'));
  }, 20_000);

  it('completes a real (simulated-network) submission and reports image artifacts', async () => {
    const { agent, runtime } = makeAgent({ dryRun: false, autoApprove: true });

    const result = await agent.run({
      input: 'a red fox in snow, cinematic, 1024x1024',
      runId: 'golden-live-offline',
    });

    expect(result.status).toBe('completed');
    expect(result.promptIds).toEqual(['prompt-test-123']);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.filename).toBe('comfyagent_00001_.png');

    // Artifacts are grounded: the recorded facts match the final report.
    expect(runtime.artifacts.submitted).toBe(true);
    expect(runtime.artifacts.simulated).toBe(false);
  }, 20_000);

  it('extracts dimensions from the prompt into EmptyLatentImage', async () => {
    const { agent, runtime } = makeAgent({ dryRun: true });
    await agent.run({ input: 'an aurora over mountains, 768x1280', runId: 'dims' });

    const stored = runtime.workflows.latest();
    const latent = Object.values(stored?.workflow ?? {}).find(
      (node) => node.class_type === 'EmptyLatentImage',
    );
    expect(latent?.inputs['width']).toBe(768);
    expect(latent?.inputs['height']).toBe(1280);
  }, 20_000);

  it('refuses submit when validation failed — the gate is structural', async () => {
    const config = testConfig({ guardrails: { dryRun: true } });
    const runtime = createRuntime({
      config,
      overrides: { fetchImpl: fixtureFetch(), socket: FAKE_SOCKET, clientId: 't' },
    });

    // Script a plan that builds a BROKEN graph (unknown class type) and then
    // tries to submit anyway.
    const { MockChatModel } = await import('../../src/agent/core-loop/model/mock.js');
    const model = new MockChatModel();
    model.script('broken graph', [
      {
        kind: 'tools',
        calls: [
          {
            name: 'build_workflow',
            arguments: {
              nodes: [
                { id: '1', class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
                { id: '2', class_type: 'KSamplerr', inputs: { model: ['1', 0], seed: 1, steps: 4, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['1', 0], negative: ['1', 0], latent_image: ['1', 0], denoise: 1 } },
                { id: '3', class_type: 'SaveImage', inputs: { images: ['2', 0] } },
              ],
            },
          },
        ],
      },
      { kind: 'tools', calls: [{ name: 'validate_workflow', arguments: {} }] },
      { kind: 'tools', calls: [{ name: 'submit_workflow', arguments: {} }] },
      { kind: 'final', text: 'done' },
    ]);

    const agent = new Agent({
      model,
      registry: runtime.registry,
      toolContext: runtime.toolContext('gate', () => {}),
      config: { maxSteps: 8, timeoutMs: 30_000 },
    });

    const result = await agent.run({ input: 'broken graph please', runId: 'gate' });

    // Nothing was submitted — the gate refused.
    expect(result.promptIds).toEqual([]);
    expect(runtime.artifacts.submitted).toBe(false);
    expect(result.workflows[0]?.validation?.valid).toBe(false);
  }, 20_000);

  it('respects maxSteps and reports progress at the limit', async () => {
    const config = testConfig({ guardrails: { dryRun: true, maxSteps: 2 } });
    const runtime = createRuntime({
      config,
      overrides: { fetchImpl: fixtureFetch(), socket: FAKE_SOCKET, clientId: 't' },
    });
    const agent = new Agent({
      model: createChatModel({ config: config.model }),
      registry: runtime.registry,
      toolContext: runtime.toolContext('cap', () => {}),
      config: { maxSteps: 2, timeoutMs: 30_000 },
    });
    const result = await agent.run({ input: 'anything', runId: 'cap' });
    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(2);
  }, 20_000);
});
