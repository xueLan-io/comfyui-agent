import { describe, expect, it } from 'vitest';

import { BridgedChatModel, toWireMessage } from '../../src/agent/v2-bridge/llm-adapter.js';
import { createGenerationTools } from '../../src/agent/v2-bridge/generation-tools.js';
import type { ChatMessage } from '../../src/agent/core-loop/core/types.js';
import { AutoApproveGate } from '../../src/agent/core-loop/guardrails/approval.js';
import { DenyAllGate } from '../../src/agent/core-loop/guardrails/approval.js';
import { JobManager } from '../../src/agent/core-loop/jobs.js';
import type { GenerationRunner } from '../../src/agent/v2-bridge/generation-tools.js';

describe('BridgedChatModel', () => {
  it('maps kernel messages/tools to the wire shape and synthesizes missing tool-call ids', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '画狐狸' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'generate_image', arguments: { prompt: '狐狸' } }] },
      { role: 'tool', content: 'running', toolCallId: 'c1', toolName: 'generate_image' },
    ];
    let seen: Record<string, unknown> | undefined;
    const model = new BridgedChatModel({
      chat: async (options) => {
        seen = options as Record<string, unknown>;
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'prov_1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"狐狸"}' } },
            // ollama-style: no id, object-valued arguments stringified by caller
            { type: 'function', function: { name: 'reroll', arguments: '{"prompt":"狐狸"}' } },
            { type: 'function', function: { name: 'broken', arguments: 'not json' } },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        };
      },
    });

    const decision = await model.chat(messages, [
      { name: 'generate_image', description: 'd', inputSchema: { type: 'object' } },
    ]);

    const wireMessages = seen?.['messages'] as Array<Record<string, unknown>>;
    expect(wireMessages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(wireMessages[1]).toEqual({ role: 'user', content: '画狐狸' });
    expect((wireMessages[2]?.['tool_calls'] as Array<Record<string, unknown>>)[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'generate_image', arguments: '{"prompt":"狐狸"}' },
    });
    expect(wireMessages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'running' });
    expect((seen?.['tools'] as Array<Record<string, unknown>>)[0]?.['type']).toBe('function');

    expect(decision.toolCalls).toHaveLength(3);
    expect(decision.toolCalls[0]?.id).toBe('prov_1');
    // ollama omits ids — the bridge synthesizes a stable one
    expect(decision.toolCalls[1]?.id).toBe('call_2_reroll');
    expect(decision.toolCalls[1]?.arguments).toEqual({ prompt: '狐狸' });
    // unparseable arguments survive as rawArguments so the registry reports them
    expect(decision.toolCalls[2]?.rawArguments).toBe('not json');
    expect(decision.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('treats non-string content (vision arrays) as empty text', async () => {
    const model = new BridgedChatModel({
      chat: async () => ({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
    });
    const decision = await model.chat([{ role: 'user', content: 'hi' }], []);
    expect(decision.text).toBe('');
    expect(decision.toolCalls).toEqual([]);
  });
});

describe('createGenerationTools — P3 background job + P5 confirmation', () => {
  function fakeRunner(overrides: Partial<GenerationRunner> = {}): GenerationRunner {
    return {
      prepare: async (input) => ({
        previewId: 'prev_1',
        summary: `将使用默认工作流生成：${input.prompt}`,
        mode: 'txt2img',
      }),
      run: async (_previewId, _edits, report) => {
        report(0.5);
        return { artifactIds: ['artifact_1'], summary: '完成', seed: '123' };
      },
      cancel: () => {},
      ...overrides,
    };
  }

  it('returns a job_id immediately and settles done in the background', async () => {
    const jobs = new JobManager();
    const tools = createGenerationTools({ jobs, approvals: new AutoApproveGate(), runner: fakeRunner() });
    const generate = tools.find((t) => t.name === 'generate_image');
    expect(generate).toBeDefined();

    const result = await generate!.handler({ prompt: '一只狐狸' }, {} as never);
    expect(result.ok).toBe(true);
    const jobId = (result.content as { job_id: string }).job_id;
    expect(jobId).toMatch(/^job_/);

    // The turn can keep flowing: the job is registered but not settled yet.
    expect(jobs.activeCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 0));
    const job = jobs.get(jobId);
    expect(job?.status).toBe('done');
    expect(job?.artifactIds).toEqual(['artifact_1']);
  });

  it('a declined confirmation denies without starting any job', async () => {
    const jobs = new JobManager();
    const tools = createGenerationTools({ jobs, approvals: new DenyAllGate('测试拒绝'), runner: fakeRunner() });
    const generate = tools.find((t) => t.name === 'generate_image')!;

    const result = await generate.handler({ prompt: '一只狐狸' }, {} as never);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('APPROVAL_DENIED');
    expect(jobs.snapshot()).toHaveLength(0);
  });

  it('surfaces prepare failures as a structured retryable error', async () => {
    const jobs = new JobManager();
    const tools = createGenerationTools({
      jobs,
      approvals: new AutoApproveGate(),
      runner: fakeRunner({ prepare: async () => { throw new Error('没有可用工作流'); } }),
    });
    const generate = tools.find((t) => t.name === 'generate_image')!;

    const result = await generate.handler({ prompt: 'x' }, {} as never);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PREPARE_FAILED');
    expect((result.content as { error: string }).error).toContain('没有可用工作流');
  });

  it('reroll forwards a fresh seed edit to the runner', async () => {
    const jobs = new JobManager();
    let seenEdits: Record<string, unknown> | undefined;
    const tools = createGenerationTools({
      jobs,
      approvals: new AutoApproveGate(),
      runner: fakeRunner({
        run: async (_id, edits, report) => {
          seenEdits = edits;
          report(1);
          return { artifactIds: ['a2'], summary: 'ok' };
        },
      }),
    });
    const reroll = tools.find((t) => t.name === 'reroll')!;
    const result = await reroll.handler({ prompt: '一只狐狸' }, {} as never);
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(seenEdits).toHaveProperty('seed');
    expect(Number(seenEdits?.['seed'])).not.toBeNaN();
  });
});
