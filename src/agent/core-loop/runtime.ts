import type { AppConfig } from './config/env.ts';
import { ComfyClient } from './comfy/client.ts';
import { NodeCatalogService } from './comfy/catalog.ts';
import { ComfySocket } from './comfy/ws.ts';
import { WorkflowStore } from './comfy/workflowStore.ts';
import { Scratchpad } from './context/scratchpad.ts';
import { GuardrailPolicy } from './guardrails/policy.ts';
import { AutoApproveGate, DenyAllGate, type ApprovalGate } from './guardrails/approval.ts';
import { createLogger, type Logger } from './observe/logger.ts';
import { createToolRegistry, ToolRegistry } from './tools/index.ts';
import { createRunArtifacts, type RunArtifacts, type ExecutionSocket, type ToolContext } from './tools/types.ts';
import type { RunEvent } from './core/events.ts';
import { randomUUID } from 'node:crypto';

export interface RuntimeOptions {
  config: AppConfig;
  /**
   * Overrides for test seams. Production wiring passes nothing: every field
   * here exists so tests can substitute the network without subclassing.
   */
  overrides?: {
    fetchImpl?: typeof fetch;
    socket?: ExecutionSocket;
    approvalGate?: ApprovalGate;
    logger?: Logger;
    /** A run id to reuse instead of generating one (tests, MCP). */
    clientId?: string;
  };
}

/**
 * The composition root.
 *
 * Wires the whole graph once — config, transports, stores, guardrails, tools —
 * and hands it to whichever entrypoint needs it (CLI loop, MCP server, tests).
 * Everything network-facing is constructed but nothing connects until first use,
 * so building a runtime is side-effect free.
 */
export interface Runtime {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly comfy: ComfyClient;
  readonly catalog: NodeCatalogService;
  readonly socket: ExecutionSocket;
  readonly workflows: WorkflowStore;
  readonly artifacts: RunArtifacts;
  readonly policy: GuardrailPolicy;
  readonly approvals: ApprovalGate;
  readonly scratchpad: Scratchpad;
  readonly clientId: string;
  readonly registry: ToolRegistry;
  toolContext(
    runId: string,
    emit: (event: RunEvent) => void,
  ): ToolContext;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { config, overrides = {} } = options;

  const logger =
    overrides.logger ?? createLogger(config.observability.logLevel, { component: 'comfyagent' });

  const comfy = new ComfyClient({
    baseUrl: config.comfy.baseUrl,
    ...(config.comfy.apiKey ? { apiKey: config.comfy.apiKey } : {}),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  const catalog = new NodeCatalogService(comfy);

  // The client id must exist before the socket: ComfyUI correlates WebSocket
  // events by the clientId query parameter on /ws, and submissions carry the
  // same id in POST /prompt. One id per process keeps them aligned.
  const clientId = overrides.clientId ?? randomUUID();
  const socket = overrides.socket ?? new ComfySocket(comfy.websocketUrl(clientId));

  const policy = new GuardrailPolicy(config.guardrails);

  // Approval wiring: explicit gates win; otherwise auto-approve only when the
  // run is dry-run-safe... it is not the runtime's call, so default to deny and
  // let the CLI choose the interactive/auto gate for itself.
  const approvals = overrides.approvalGate ?? new DenyAllGate();

  const workflows = new WorkflowStore();
  const scratchpad = new Scratchpad();
  const artifacts = createRunArtifacts();
  const registry = createToolRegistry();

  return {
    config,
    logger,
    comfy,
    catalog,
    socket,
    workflows,
    artifacts,
    policy,
    approvals,
    scratchpad,
    clientId,
    registry,
    toolContext(_runId: string, emit: (event: RunEvent) => void) {
      // Notes flow through the same event bus as everything else, so CLI,
      // tracer, and tests observe them uniformly.
      const note = (text: string): void => {
        emit({ type: 'note', step: 0, text });
      };
      return {
        comfy,
        catalog,
        socket,
        workflows,
        artifacts,
        clientId,
        policy,
        approvals,
        scratchpad,
        logger,
        note,
        emit,
      };
    },
  };
}

export { AutoApproveGate, DenyAllGate };
