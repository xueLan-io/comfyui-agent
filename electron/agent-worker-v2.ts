/**
 * v2 agent worker (agent-v2-design.md §7.3): same RPC protocol shell as
 * agent-worker.ts, but the turn runs on the core-loop kernel.
 *
 * Selected by the `agentV2Kernel` config flag in agent-process.ts; the legacy
 * worker remains the default and is untouched. Until S4 lands, this worker
 * answers a minimal method surface and replies NOT_IMPLEMENTED_IN_V2 to
 * anything else — the main process treats that like any RPC error, so a v2
 * misconfiguration degrades loudly instead of silently.
 *
 * Wiring per design §2/§3:
 *  - Thread      — one JSONL per session, the single source of truth (P7)
 *  - JobManager  — generation runs as a background job; settle appends a
 *                  task_notification to the thread and wakes an idle agent (P3)
 *  - Approval    — a confirmation pushes `agent:approval` to the main process
 *                  and the suspended call resumes on `approval.response` (P5)
 *  - Tools       — core-loop surface (discovery/build/validate/submit) plus
 *                  generate_image/reroll backed by the legacy DirectService
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { ComfyUIClient } from '../src/agent/tools/comfyui/client.mjs';
import { ComfyExecutor } from '../src/runtime/executor/comfy-executor.mjs';
import { DirectService } from '../src/runtime/direct/direct-service.mjs';
import { LLMProvider } from '../src/agent/llm/provider.ts';

import { Agent } from '../src/agent/core-loop/core/agent.ts';
import type { RunEvent } from '../src/agent/core-loop/core/events.ts';
import type { ChatMessage } from '../src/agent/core-loop/core/types.ts';
import { ALL_TOOLS, createToolRegistry } from '../src/agent/core-loop/tools/index.ts';
import type { ToolRegistry } from '../src/agent/core-loop/tools/registry.ts';
import type { ToolContext } from '../src/agent/core-loop/tools/types.ts';
import type { ApprovalGate, ApprovalRequest, ApprovalDecision } from '../src/agent/core-loop/guardrails/approval.ts';
import { createRuntime } from '../src/agent/core-loop/runtime.ts';
import type { AppConfig } from '../src/agent/core-loop/config/env.ts';
import { Tracer } from '../src/agent/core-loop/observe/trace.ts';
import { JobManager, type JobSettledEvent } from '../src/agent/core-loop/jobs.ts';
import { Thread, threadPath } from '../src/agent/core-loop/thread.ts';
import { BridgedChatModel, type BridgeLLM } from '../src/agent/v2-bridge/llm-adapter.ts';
import { createGenerationTools, type GenerationRunner } from '../src/agent/v2-bridge/generation-tools.ts';

const parentPort = (process as any).parentPort || null;

function send(message: any): void {
  if (parentPort) {
    try { parentPort.postMessage(message); } catch (error) {
      console.error('[agent-worker-v2] postMessage failed:', (error as any)?.message || error);
    }
    return;
  }
  if (!process.connected) return;
  try { process.send!(message); } catch (error) {
    console.error('[agent-worker-v2] process.send failed:', (error as any)?.message || error);
  }
}

/** P5: the suspended tool call, parked until the host answers its card. */
class PendingApprovalGate implements ApprovalGate {
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly emit: (payload: { id: string; action: string; detail: string }) => void;

  constructor(emit: (payload: { id: string; action: string; detail: string }) => void) {
    this.emit = emit;
  }

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, resolve);
      this.emit({ id, action: req.action, detail: req.detail });
    });
  }

  resolve(id: string, approved: boolean, reason = ''): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve({ approved, ...(reason ? { reason } : {}) });
    return true;
  }

  /** Deny everything still parked — used on stop so nothing hangs. */
  dispose(): void {
    for (const [id, resolve] of this.pending) {
      resolve({ approved: false, reason: 'Worker stopped.' });
      this.pending.delete(id);
    }
  }
}

const agentMethods = new Set(['handleTurn', 'cancel']);

let thread: Thread | null = null;
let jobs: JobManager | null = null;
let approvals: PendingApprovalGate | null = null;
let agent: Agent | null = null;
let llm: LLMProvider | null = null;
let direct: any = null; // DirectService's .mjs inference omits the executor field
let workerConfig: Record<string, any> = {};
let running = false;
let currentAbort: AbortController | null = null;
let currentTraceListener: ((event: RunEvent) => void) | null = null;

function dataRoot(config: Record<string, any>): string {
  return config.userDataPath ? join(config.userDataPath, 'agent-data') : join(process.cwd(), 'agent-data');
}

/** Thread → kernel context projection (design §3 `toLLM(thread)`). */
function projectThread(sessionThread: Thread): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const record of sessionThread.all().slice(-40)) {
    if (record.role === 'user') {
      history.push({ role: 'user', content: record.content });
    } else if (record.role === 'agent') {
      history.push({
        role: 'assistant',
        content: record.content,
        ...(record.toolCall ? { toolCalls: [{ id: record.toolCall.id, name: record.toolCall.name, arguments: record.toolCall.args }] } : {}),
      });
    } else if (record.role === 'tool') {
      history.push({
        role: 'tool',
        content: record.content,
        ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
        ...(record.toolName ? { toolName: record.toolName } : {}),
      });
    } else {
      history.push({ role: 'user', content: `[system] ${record.content}` });
    }
  }
  return history;
}

function directRunner(config: Record<string, any>): GenerationRunner {
  const progressFraction = (event: any): number => {
    if (typeof event === 'number') return event;
    if (typeof event?.fraction === 'number') return event.fraction;
    if (typeof event?.percent === 'number') return event.percent / 100;
    if (typeof event?.progress === 'number') return event.progress > 1 ? event.progress / 100 : event.progress;
    return 0;
  };
  return {
    async prepare(input) {
      const preview = await direct!.prepare({
        positive: input.prompt,
        negative: input.negativePrompt ?? '',
        workflowName: input.workflowPath || config.workflowName || '',
        origin: 'agent-v2',
        sessionId: config.sessionId || '',
        projectId: config.projectId || '',
        principalId: config.principalId || 'principal_worker',
        tenantId: config.tenantId || 'tenant_local',
      });
      const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
      return {
        previewId: preview.previewId,
        mode: preview.modelType || preview.model || 'generic',
        summary: [
          `工作流：${preview.workflowName || '(默认)'}（${preview.workflow?.valid === false ? '校验未过' : '就绪'}）`,
          `正向：${preview.positive}`,
          preview.negative ? `负向：${preview.negative}` : '',
          ...warnings.slice(0, 3).map((w: string) => `注意：${w}`),
        ].filter(Boolean).join('\n'),
      };
    },
    async run(previewId, edits, report, signal) {
      const result = await direct!.run(previewId, edits, {
        onProgress: (event: any) => report(progressFraction(event)),
        signal,
        executionId: previewId,
      });
      const media = Array.isArray(result?.media) ? result.media : [];
      const seed = result?.settings?.seed;
      return {
        artifactIds: media.map((item: any, index: number) => `artifact_${result?.promptId || previewId}_${index}`),
        summary: `生成完成：${media.length} 张`,
        ...(seed !== undefined ? { seed: String(seed) } : {}),
      };
    },
    cancel(previewId) {
      direct?.cancel(previewId);
    },
  };
}

/** Forward one kernel run as legacy-style events the renderer already knows. */
function runEventForwarder(sessionThread: Thread) {
  const pendingCalls: Array<{ id: string; name: string }> = [];
  return (event: RunEvent): void => {
    switch (event.type) {
      case 'run_start':
        send({ type: 'event', eventType: 'agent:status', data: { state: 'running', taskId: event.runId } });
        break;
      case 'model_decision':
        for (const call of event.toolCalls) {
          pendingCalls.push({ id: call.id, name: call.name });
          sessionThread.append({
            role: 'agent',
            content: event.text || '',
            toolCall: { id: call.id, name: call.name, args: call.arguments as Record<string, unknown> },
          });
          send({ type: 'event', eventType: 'agent:tool-call', data: { name: call.name, args: call.arguments } });
        }
        break;
      case 'tool_result': {
        const call = pendingCalls.shift();
        const summary = JSON.stringify(event.result).slice(0, 2000);
        sessionThread.append({
          role: 'tool',
          content: summary,
          ...(call ? { toolCallId: call.id, toolName: call.name } : { toolName: event.name }),
        });
        send({
          type: 'event',
          eventType: 'agent:tool-result',
          data: { name: event.name, ok: event.result.ok, errorCode: event.result.errorCode || '', durationMs: event.durationMs },
        });
        break;
      }
      case 'error':
        send({ type: 'event', eventType: 'agent:error', data: { message: event.message, code: event.code || '' } });
        break;
      case 'run_end':
        send({ type: 'event', eventType: 'agent:status', data: { state: 'idle', status: event.status, steps: event.steps, durationMs: event.durationMs } });
        break;
      default:
        break; // step_start / compaction / note stay in the trace, not the UI feed
    }
  };
}

async function runTurn(text: string, options: { appendUser: boolean }): Promise<void> {
  if (!thread || !agent || !jobs) throw new Error('v2 worker is not initialized');
  if (running) throw Object.assign(new Error('A turn is already running'), { code: 'TURN_BUSY' });
  running = true;
  currentAbort = new AbortController();
  const sessionThread = thread;
  const runId = `v2_${randomUUID().slice(0, 8)}`;
  const tracer = new Tracer(join(dataRoot(workerConfig), 'traces-v2'), runId);
  currentTraceListener = tracer.listener();
  try {
    if (options.appendUser) sessionThread.append({ role: 'user', content: text });
    const result = await agent.run({
      input: text,
      runId,
      history: projectThread(sessionThread).slice(0, -1),
      signal: currentAbort.signal,
    });
    sessionThread.append({ role: 'agent', content: result.text });
    send({ type: 'event', eventType: 'agent:message', data: { text: result.text, streaming: false, done: true, status: result.status } });
  } finally {
    running = false;
    currentAbort = null;
    currentTraceListener = null;
    await tracer.flush().catch(() => {});
  }
}

async function start(config: Record<string, any> = {}): Promise<void> {
  workerConfig = config;
  ComfyUITool.setClient(new ComfyUIClient({ baseUrl: config.comfyBaseUrl || 'http://127.0.0.1:8188' }));
  llm = new LLMProvider(config.llm || {});

  const sessionThread = await Thread.load(threadPath(dataRoot(config), config.sessionId || 'session_worker'));
  thread = sessionThread;

  jobs = new JobManager();
  approvals = new PendingApprovalGate((payload) => send({ type: 'event', eventType: 'agent:approval', data: payload }));

  direct = new (DirectService as any)({ executor: new ComfyExecutor(), workflowDir: config.workflowDir || '' });
  const runner = directRunner(config);

  jobs.onSettled((event: JobSettledEvent) => {
    const outcome = event.outcome;
    const summary = outcome.status === 'done'
      ? `后台生成完成（${outcome.artifactIds.length} 张）`
      : outcome.status === 'failed'
        ? `后台生成失败：${outcome.error}`
        : '后台生成已取消';
    sessionThread.append({
      role: 'system',
      content: `task_notification: ${summary}`,
      jobId: event.job.id,
      ...(outcome.status === 'done' ? { artifactRefs: outcome.artifactIds.map((id, index) => ({ id, kind: 'image', path: `job:${event.job.id}/${index}` })) } : {}),
    });
    send({ type: 'event', eventType: 'agent:message', data: { text: summary, streaming: false, done: true, jobId: event.job.id, jobStatus: outcome.status } });
    // P3 wake-up: an idle agent comments on the settled job; a busy one picks
    // it up from the thread at its next turn.
    if (!running) {
      void runTurn(`[后台任务通知] ${summary}`, { appendUser: false }).catch((error) => {
        send({ type: 'event', eventType: 'agent:error', data: { message: (error as Error).message, code: (error as any).code || '' } });
      });
    }
  });

  const generationTools = createGenerationTools({ jobs, approvals, runner });
  const registry: ToolRegistry = createToolRegistry([...ALL_TOOLS, ...generationTools]);
  const forwarder = runEventForwarder(sessionThread);

  // Kernel composition root: ComfyUI HTTP client + node catalogue + policy +
  // approval injection. Built as a plain AppConfig (not env) because the
  // worker's settings arrive over the init RPC, not the process environment.
  const appConfig: AppConfig = {
    model: {
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      name: String(workerConfig.llm?.active?.model || 'bridged'),
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 120_000,
    },
    comfy: {
      baseUrl: String(config.comfyBaseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
      apiKey: '',
    },
    guardrails: {
      // generate_image runs its own single confirmation; submit_workflow gates
      // through the same approval gate below.
      dryRun: false,
      maxSteps: 24,
      timeoutMs: 600_000,
      nodeAllowlist: [],
    },
    observability: { logLevel: 'info', traceDir: 'traces-v2' },
  };
  const runtime = createRuntime({
    config: appConfig,
    overrides: {
      approvalGate: approvals,
      clientId: String(config.sessionId || 'session_worker'),
    },
  });

  agent = new Agent({
    model: new BridgedChatModel(llm as unknown as BridgeLLM, appConfig.model.name),
    registry,
    toolContext: runtime.toolContext('v2-worker', (event) => forwarder(event)),
    config: { maxSteps: appConfig.guardrails.maxSteps, timeoutMs: appConfig.guardrails.timeoutMs },
    listeners: [(event: RunEvent) => {
      forwarder(event);
      currentTraceListener?.(event);
    }],
  });
}

async function stop(): Promise<void> {
  approvals?.dispose();
  currentAbort?.abort();
  try { await thread?.flush(); } catch {}
}

function snapshot() {
  return {
    workflowDir: workerConfig.workflowDir || '',
    isRunning: running,
    state: running ? 'running' : 'idle',
    taskId: '',
    kernel: 'v2',
    sessionManager: { projects: [], sessions: [] },
    projectMemory: {},
    tasks: [],
  };
}

function runCall(message: any): Promise<void> {
  return invoke(message.method, message.args || [])
    .then(result => send({ type: 'response', id: message.id, ok: true, result, state: snapshot() }))
    .catch(error => send({
      type: 'response',
      id: message.id,
      ok: false,
      error: error.message,
      code: error.code || '',
      stack: error.stack,
      state: snapshot(),
    }));
}

async function invoke(method: string, args: any[] = []): Promise<any> {
  switch (method) {
    case 'handleTurn': {
      const text = typeof args[0] === 'string' ? args[0] : String(args[0]?.text ?? args[0]?.message ?? '');
      if (!text.trim()) throw Object.assign(new Error('Empty turn'), { code: 'EMPTY_TURN' });
      await runTurn(text, { appendUser: true });
      return { ok: true };
    }
    case 'cancel': {
      currentAbort?.abort();
      if (jobs) for (const job of jobs.snapshot()) jobs.cancel(job.id);
      return { ok: true };
    }
    case 'session.getState':
      return snapshot();
    case 'session.flush':
      await thread?.flush();
      return true;
    case 'approval.response': {
      const [id, approved, reason] = args;
      return approvals?.resolve(String(id), Boolean(approved), reason ? String(reason) : '') ?? false;
    }
    default:
      throw Object.assign(new Error(`Method not implemented in v2 worker: ${method}`), { code: 'NOT_IMPLEMENTED_IN_V2' });
  }
}

const handleMessage = async (message: any) => {
  if (parentPort) message = message?.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    try {
      await start(message.config);
      send({ type: 'ready' });
    } catch (error) {
      send({ type: 'fatal', error: (error as any).message, stack: (error as any).stack });
      setImmediate(() => process.exit(1));
    }
    return;
  }
  if (message.type === 'stop') {
    void stop().then(() => process.exit(0));
    return;
  }
  if (message.type !== 'call' || typeof message.id !== 'string') return;
  void runCall(message);
};

if (parentPort) parentPort.on('message', handleMessage);
else process.on('message', handleMessage);

if (!parentPort) {
  process.on('disconnect', () => {
    void stop().then(() => process.exit(0));
  });
}
