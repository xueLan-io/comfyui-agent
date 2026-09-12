/**
 * ComfyUI WebSocket client.
 *
 * Turns the raw message stream into a promise that settles on a terminal state
 * for one `prompt_id`. Terminal states are `execution_success`,
 * `execution_error`, and `execution_interrupted`; older servers also signal
 * completion with an `executing` message whose `node` is null/None.
 *
 * Message types: docs/research/2026-landscape.md §8
 */

import WebSocket from 'ws';

import { compactExecutionError, ComfyError, type CompactError } from './errors.ts';

export interface ProgressEvent {
  node: string | null;
  value: number;
  max: number;
  /** 0..1, or undefined when max is 0. */
  fraction?: number;
}

export interface ExecutionOutcome {
  promptId: string;
  status: 'success' | 'error' | 'interrupted';
  /** Node id -> its `executed` output payload. Image refs live here. */
  outputs: Record<string, unknown>;
  /** Nodes served from cache instead of being re-run. */
  cachedNodes: string[];
  error?: CompactError;
  durationMs: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
}

interface RawMessage {
  type?: string;
  data?: Record<string, unknown>;
}

/** Extract image references from an `executed` payload. */
export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
  node: string;
}

export function extractImages(outputs: Record<string, unknown>): ImageRef[] {
  const images: ImageRef[] = [];
  for (const [node, payload] of Object.entries(outputs)) {
    const record = payload as Record<string, unknown> | null;
    const list = record?.['images'];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const img = item as Record<string, unknown>;
      if (typeof img?.['filename'] === 'string') {
        images.push({
          filename: img['filename'],
          subfolder: typeof img['subfolder'] === 'string' ? img['subfolder'] : '',
          type: typeof img['type'] === 'string' ? img['type'] : 'output',
          node,
        });
      }
    }
  }
  return images;
}

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
/** How long to allow the socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

export class ComfySocket {
  private socket: WebSocket | undefined;
  private opening: Promise<void> | undefined;
  private waiters = new Map<string, (outcome: ExecutionOutcome) => void>();
  private progressHandlers = new Map<string, (event: ProgressEvent) => void>();
  private readonly startedAt = new Map<string, number>();
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private ensureOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new ComfyError(
            'COMFY_WS_TIMEOUT',
            `Timed out opening WebSocket to ${this.url}`,
            true,
            undefined,
            'Check that ComfyUI is running and reachable.',
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (error: Error) => {
        clearTimeout(timer);
        this.opening = undefined;
        reject(
          new ComfyError(
            'COMFY_WS_ERROR',
            `WebSocket error for ${this.url}: ${error.message}`,
            true,
            undefined,
            'Check that ComfyUI is running and reachable.',
          ),
        );
      });
      socket.on('message', (data: WebSocket.RawData) => this.onMessage(data));
      socket.on('close', () => {
        this.socket = undefined;
        this.opening = undefined;
      });
    });

    return this.opening;
  }

  private onMessage(raw: WebSocket.RawData): void {
    let message: RawMessage;
    try {
      message = JSON.parse(raw.toString()) as RawMessage;
    } catch {
      return; // Ignore unparseable frames rather than killing the wait.
    }
    const type = message.type;
    const data = message.data ?? {};
    if (!type) return;

    if (type === 'execution_start') {
      const id = data['prompt_id'];
      if (typeof id === 'string') this.startedAt.set(id, Date.now());
      return;
    }

    if (type === 'progress') {
      const id = data['prompt_id'];
      if (typeof id !== 'string') return;
      const handler = this.progressHandlers.get(id);
      if (!handler) return;
      const value = typeof data['value'] === 'number' ? data['value'] : 0;
      const max = typeof data['max'] === 'number' ? data['max'] : 0;
      const node = data['node'];
      handler({
        node: typeof node === 'string' ? node : null,
        value,
        max,
        ...(max > 0 ? { fraction: value / max } : {}),
      });
      return;
    }

    if (type === 'execution_cached') {
      const id = data['prompt_id'];
      if (typeof id !== 'string') return;
      this.settle(id, {
        promptId: id,
        status: 'success',
        outputs: {},
        cachedNodes: Array.isArray(data['nodes']) ? data['nodes'].map(String) : [],
        durationMs: this.elapsed(id),
      });
      return;
    }

    if (type === 'execution_success') {
      const id = data['prompt_id'];
      if (typeof id === 'string') this.markSuccess(id);
      return;
    }

    if (type === 'execution_error') {
      const id = data['prompt_id'];
      if (typeof id !== 'string') return;
      this.settle(id, {
        promptId: id,
        status: 'error',
        outputs: this.takeOutputs(id),
        cachedNodes: [],
        error: compactExecutionError({
          ...(typeof data['node_id'] === 'string' ? { node_id: data['node_id'] } : {}),
          ...(typeof data['node_type'] === 'string' ? { node_type: data['node_type'] } : {}),
          ...(typeof data['exception_type'] === 'string'
            ? { exception_type: data['exception_type'] } : {}),
          ...(typeof data['exception_message'] === 'string'
            ? { exception_message: data['exception_message'] } : {}),
          ...(Array.isArray(data['traceback']) ? { traceback: data['traceback'].map(String) } : {}),
        }),
        durationMs: this.elapsed(id),
      });
      return;
    }

    if (type === 'execution_interrupted') {
      const id = data['prompt_id'];
      if (typeof id !== 'string') return;
      this.settle(id, {
        promptId: id,
        status: 'interrupted',
        outputs: this.takeOutputs(id),
        cachedNodes: [],
        error: {
          code: 'EXECUTION_INTERRUPTED',
          message: 'Execution was interrupted.',
          recoverable: true,
          ...(typeof data['node_id'] === 'string' ? { node: data['node_id'] } : {}),
        },
        durationMs: this.elapsed(id),
      });
      return;
    }

    if (type === 'executed') {
      const id = data['prompt_id'];
      const node = data['node'];
      if (typeof id !== 'string') return;
      if (data['output'] !== undefined) {
        const bucket = this.outputs.get(id) ?? {};
        bucket[typeof node === 'string' ? node : 'unknown'] = data['output'];
        this.outputs.set(id, bucket);
      }
      return;
    }

    if (type === 'executing') {
      const id = data['prompt_id'];
      if (typeof id !== 'string') return;
      const node = data['node'];
      // Older servers mark completion with node === null / "None" and no
      // execution_success; treat it as success only if nothing else settled us.
      if (node === null || node === 'None') this.markSuccess(id);
    }
  }

  /** Per-prompt accumulation of `executed` payloads, needed for image refs. */
  private outputs = new Map<string, Record<string, unknown>>();

  private takeOutputs(id: string): Record<string, unknown> {
    const value = this.outputs.get(id) ?? {};
    this.outputs.delete(id);
    return value;
  }

  private elapsed(id: string): number {
    const started = this.startedAt.get(id);
    return started ? Date.now() - started : 0;
  }

  private markSuccess(id: string): void {
    this.settle(id, {
      promptId: id,
      status: 'success',
      outputs: this.takeOutputs(id),
      cachedNodes: [],
      durationMs: this.elapsed(id),
    });
  }

  private settle(id: string, outcome: ExecutionOutcome): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    this.progressHandlers.delete(id);
    this.startedAt.delete(id);
    waiter(outcome);
  }

  /**
   * Resolve when `promptId` reaches a terminal state, or reject on timeout.
   *
   * Note: ComfyUI's `/ws` stream carries all clients' events, so events for
   * other prompt ids are ignored rather than mistaken for ours.
   */
  async waitForResult(promptId: string, options: WaitOptions = {}): Promise<ExecutionOutcome> {
    await this.ensureOpen();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

    if (options.onProgress) this.progressHandlers.set(promptId, options.onProgress);
    this.startedAt.set(promptId, Date.now());

    return new Promise<ExecutionOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(promptId);
        this.progressHandlers.delete(promptId);
        reject(
          new ComfyError(
            'COMFY_EXEC_TIMEOUT',
            `Timed out after ${timeoutMs} ms waiting for prompt ${promptId}.`,
            true,
            undefined,
            'Check the ComfyUI queue; the job may still be running. Use server_status or interrupt.',
          ),
        );
      }, timeoutMs);

      this.waiters.set(promptId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.opening = undefined;
  }
}
