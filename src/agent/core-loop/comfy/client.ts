import { ComfyError } from './errors.ts';
import type { ApiWorkflow } from './workflow.ts';

/** Shape of ComfyUI's node catalogue entry, narrowed to what we consume. */
export interface ObjectInfoNode {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: unknown[];
  output_name?: string[];
  name?: string;
  display_name?: string;
  description?: string;
  category?: string;
  output_node?: boolean;
  deprecated?: boolean;
  experimental?: boolean;
}

export type ObjectInfoResponse = Record<string, ObjectInfoNode>;

export interface SystemStats {
  system?: Record<string, unknown>;
  devices?: Array<Record<string, unknown>>;
}

export interface PromptSubmission {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
}

export interface HistoryEntry {
  prompt?: unknown;
  outputs?: Record<string, unknown>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

export interface QueueState {
  queue_running?: unknown[];
  queue_pending?: unknown[];
}

export interface ComfyClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Thin HTTP client over the ComfyUI routes we use.
 *
 * Only I/O lives here — every transformation of a response into something the
 * model sees happens in `objectInfo.ts` / `errors.ts`, which keeps the logic
 * testable without a server (see docs/architecture.md, Testing strategy).
 *
 * Routes: docs/research/2026-landscape.md §8
 */
export class ComfyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers((init.headers as Record<string, string>) ?? {}),
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ComfyError(
        'COMFY_UNREACHABLE',
        `Cannot reach ComfyUI at ${this.baseUrl}: ${reason}`,
        true,
        undefined,
        'Is the ComfyUI server running and is COMFY_BASE_URL correct?',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path, { method: 'GET' });
    if (!response.ok) {
      throw new ComfyError(
        'COMFY_HTTP_ERROR',
        `GET ${path} returned ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new ComfyError('COMFY_BAD_RESPONSE', `POST ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      // Preserve the body: POST /prompt puts node_errors there, and they are the
      // whole point of the failure for the model.
      const error = new ComfyError(
        'COMFY_HTTP_ERROR',
        `POST ${path} returned ${response.status} ${response.statusText}`,
      );
      (error as ComfyError & { payload?: unknown }).payload = parsed;
      throw error;
    }
    return parsed as T;
  }

  /** Full node catalogue. Large — call once per process, never inline into context. */
  async getObjectInfo(): Promise<ObjectInfoResponse> {
    return this.getJson<ObjectInfoResponse>('/object_info');
  }

  async getSystemStats(): Promise<SystemStats> {
    return this.getJson<SystemStats>('/system_stats');
  }

  /** Model filenames per folder, e.g. "checkpoints", "loras", "vae". */
  async getModels(folder?: string): Promise<string[]> {
    const path = folder ? `/models/${encodeURIComponent(folder)}` : '/models';
    return this.getJson<string[]>(path);
  }

  async getHistory(promptId?: string): Promise<Record<string, HistoryEntry>> {
    return this.getJson<Record<string, HistoryEntry>>(
      promptId ? `/history/${encodeURIComponent(promptId)}` : '/history',
    );
  }

  async getQueue(): Promise<QueueState> {
    return this.getJson<QueueState>('/queue');
  }

  /** Submit an API-format workflow. `clientId` correlates WebSocket events. */
  async submitPrompt(workflow: ApiWorkflow, clientId: string): Promise<PromptSubmission> {
    return this.postJson<PromptSubmission>('/prompt', { prompt: workflow, client_id: clientId });
  }

  async interrupt(): Promise<void> {
    await this.postJson<unknown>('/interrupt', {});
  }

  async free(unloadModels = true, freeMemory = true): Promise<void> {
    await this.postJson<unknown>('/free', {
      unload_models: unloadModels,
      free_memory: freeMemory,
    });
  }

  /** Build the URL for a produced image (`GET /view`). */
  viewUrl(params: {
    filename: string;
    subfolder?: string;
    type?: string;
  }): string {
    const query = new URLSearchParams({
      filename: params.filename,
      subfolder: params.subfolder ?? '',
      type: params.type ?? 'output',
    });
    return `${this.baseUrl}/view?${query.toString()}`;
  }

  /** WebSocket URL for `/ws`, carrying the client id ComfyUI expects. */
  websocketUrl(clientId: string): string {
    const url = new URL(`${this.baseUrl}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', clientId);
    return url.toString();
  }
}
