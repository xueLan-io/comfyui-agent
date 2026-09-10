import { debugLog } from './debug-log.mjs';
import type { ChatMessage, ChatToolCall } from '../types/llm.ts';

export const REASONING_OUTPUT_MULTIPLIER: Record<string, number> = { low: 2, medium: 3, high: 4 };
export const REASONING_OUTPUT_HEADROOM: Record<string, number> = { low: 512, medium: 1024, high: 2048 };
// The provider's accepted output cap. Kept above the chat budget so an
// exhausted call can escalate meaningfully, and below typical model limits to
// avoid provider rejections on very large max_tokens.
export const MAX_REASONING_OUTPUT_TOKENS = 16384;

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LLMChatResult {
  role?: string;
  content: any;
  tool_calls?: ChatToolCall[];
  usage?: LLMUsage;
  finishReason: string;
  [key: string]: unknown;
}

export interface OpenAIProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyError?: string;
  headers?: Record<string, string>;
  reasoningEffort?: string;
  local?: boolean;
  contextWindow?: number;
  vision?: boolean;
}

export interface ChatRequestOptions {
  messages: ChatMessage[];
  tools?: Record<string, any>[];
  toolChoice?: string | Record<string, any>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  onChunk?: (text: string) => void;
  onReasoningStart?: () => void;
  onReasoningText?: (text: string) => void;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

interface AccumToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

// Reasoning models count thinking tokens against max_tokens. A caller's
// maxTokens is a *content* budget; reserve reasoning headroom so heavy
// thinking cannot starve the actual answer (finish_reason "length" with zero
// content). Never exceed the provider's accepted output cap.
export function reasoningOutputBudget(maxTokens: unknown, reasoningEffort?: string | null, contextWindow: unknown = 32768): number {
  if (!reasoningEffort) return Math.max(Number(maxTokens) || 0, 1);
  const base = Math.max(Number(maxTokens) || 0, 1);
  const multiplier = REASONING_OUTPUT_MULTIPLIER[reasoningEffort] || 3;
  const headroom = REASONING_OUTPUT_HEADROOM[reasoningEffort] || 1024;
  const inflated = Math.max(base * multiplier, base + headroom);
  const cap = Number(contextWindow) > 0 ? Math.min(Number(contextWindow), MAX_REASONING_OUTPUT_TOKENS) : MAX_REASONING_OUTPUT_TOKENS;
  return Math.min(inflated, cap);
}

function validateRequestHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    const stringValue = String(value);
    if ([...stringValue].some(character => (character.codePointAt(0) ?? 0) > 255)) {
      if (name.toLowerCase() === 'authorization') {
        throw new Error('Saved API key could not be decrypted. Re-enter it in Settings.');
      }
      throw new Error(`Custom request header "${name}" contains unsupported characters.`);
    }
  }
}

function connectionError(error: unknown, baseUrl: string): Error & { code: string } {
  const e = error as any;
  const detail = String(e?.cause?.message || e?.cause?.code || e?.message || 'unknown connection failure');
  let endpoint = baseUrl;
  try { endpoint = new URL(baseUrl).origin; } catch {}
  const wrapped = new Error(`无法连接语言模型服务（${endpoint}）：${detail}`) as Error & { code: string };
  wrapped.code = 'LLM_NETWORK_ERROR';
  return wrapped;
}

function abortError(reason: unknown, timeoutMs: number): Error & { code: string } {
  const timedOut = reason === 'timeout';
  const error = new Error(timedOut
    ? `语言模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`
    : '语言模型请求已取消') as Error & { code: string };
  error.code = timedOut ? 'LLM_TIMEOUT' : 'LLM_CANCELLED';
  return error;
}

export class OpenAICompatibleProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyError: string;
  headers: Record<string, string>;
  reasoningEffort: string;
  local: boolean;
  contextWindow: number;
  vision: boolean;
  private _controller: AbortController | null = null;

  constructor({ baseUrl, model, apiKey, apiKeyError = '', headers = {}, reasoningEffort = '', local = false, contextWindow = 32768, vision = false }: OpenAIProviderConfig) {
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    try {
      const url = new URL(this.baseUrl);
      if (url.pathname === '' || url.pathname === '/') this.baseUrl += '/v1';
    } catch {}
    this.model = model || 'gpt-4o';
    this.apiKey = apiKey || '';
    this.apiKeyError = apiKeyError;
    this.headers = headers;
    this.reasoningEffort = reasoningEffort;
    this.local = local;
    this.contextWindow = contextWindow;
    this.vision = Boolean(vision);
  }

  supportsVision(): boolean {
    return this.vision;
  }

  async healthCheck({ timeoutMs = 1000 }: { timeoutMs?: number } = {}): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {}),
        ...this.headers,
      };
      const res = await fetch(this.baseUrl + '/models', { method: 'GET', headers, signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat({ messages, tools, toolChoice, temperature = 0.7, maxTokens = 4096, timeoutMs = 60000, onChunk, onReasoningStart, onReasoningText, reasoningEffort, signal }: ChatRequestOptions): Promise<LLMChatResult> {
    if (this.apiKeyError) throw new Error(this.apiKeyError);
    const streaming = typeof onChunk === 'function';
    const effort = reasoningEffort !== undefined ? reasoningEffort : this.reasoningEffort;
    const effectiveMaxTokens = reasoningOutputBudget(maxTokens, effort, this.contextWindow);
    // The official OpenAI API rejects reasoning_effort on non-reasoning models,
    // and rejects max_tokens/temperature≠1 on reasoning models. Shape the body
    // per family there; third-party compatible endpoints keep the legacy shape.
    let officialOpenAI = false;
    try {
      officialOpenAI = /(^|\.)(openai\.com|chatgpt\.com)$/i.test(new URL(this.baseUrl).hostname);
    } catch {}
    const reasoningModel = officialOpenAI && /^(o[1345]([-.\d]|$)|gpt-5)/i.test(this.model);

    const body: Record<string, any> = {
      model: this.model,
      messages,
      [reasoningModel ? 'max_completion_tokens' : 'max_tokens']: effectiveMaxTokens,
      stream: streaming,
      ...(this.local ? { thinking: false } : {}),
    };
    if (!reasoningModel) body.temperature = temperature;

    if (tools && tools.length > 0) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (effort && !this.local && (!officialOpenAI || reasoningModel)) body.reasoning_effort = effort;
    debugLog('REQ', JSON.stringify({
      model: this.model,
      messages: messages.map(message => ({
        role: message.role,
        contentLen: typeof message.content === 'string'
          ? message.content.length
          : Array.isArray(message.content) ? message.content.length : 0,
      })),
      temperature,
      maxTokens,
      effectiveMaxTokens,
      streaming,
      reasoningEffort: effort,
      hasTools: Boolean(tools?.length),
    }));
    const controller = new AbortController();
    this._controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (reason?: unknown) => void;
    let timeoutReject!: (reason?: unknown) => void;
    const abortRace = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const fireTimeout = () => {
      controller.abort('timeout');
      timeoutReject(abortError('timeout', timeoutMs));
    };
    // Idle timeout: reset on every received chunk so legitimately long streams
    // are not killed mid-generation while tokens are still flowing.
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(fireTimeout, timeoutMs);
    };
    resetTimer();
    const abortFromCaller = () => {
      rejectAbort(abortError('cancelled', timeoutMs));
      controller.abort(signal?.reason || 'cancelled');
    };
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    // Hard guard: AbortController alone can fail to interrupt a hung fetch on
    // some network stacks, so every blocking await races against explicit
    // timeout/cancellation rejections and can never hang forever.
    const guarded = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, timeoutPromise, abortRace]);
    let res: Response;
    try {
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...this.headers,
      };
      validateRequestHeaders(requestHeaders);
      res = await guarded(fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
      if (this._controller === controller) this._controller = null;
      if (controller.signal.aborted) throw abortError(controller.signal.reason, timeoutMs);
      throw connectionError(error, this.baseUrl);
    }

    try {
      if (!res.ok) {
        const text = await guarded(res.text());
        throw new Error(`LLM API error (${res.status}): ${text.slice(0, 500)}`);
      }

      if (!streaming) {
        const text = await guarded(res.text());
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`LLM API returned a non-JSON response from ${this.baseUrl}`);
        }
        if (!data.choices?.[0]?.message) throw new Error('LLM API response is missing choices[0].message');
        const message = data.choices[0].message;
        const finishReason = data.choices[0].finish_reason || 'unknown';
        const usage: LLMUsage | null = data.usage ? {
          inputTokens: Number(data.usage.prompt_tokens) || 0,
          outputTokens: Number(data.usage.completion_tokens) || 0,
          totalTokens: Number(data.usage.total_tokens) || 0,
        } : null;
        if (typeof message.content === 'string' && !message.content.trim() && !message.tool_calls?.length) {
          const error = new Error('语言模型返回了空响应') as Error & { code: string; budgetExhausted?: boolean };
          error.code = 'EMPTY_MODEL_RESPONSE';
          if (finishReason === 'length') error.budgetExhausted = true;
          throw error;
        }
        return {
          ...message,
          ...(usage ? { usage } : {}),
          finishReason,
        };
      }

      if (!res.body) throw new Error('LLM API returned an empty streaming response');
      const reader = res.body.getReader();
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let usage: LLMUsage | null = null;
      let finishReason = 'unknown';
      let sawDone = false;
      let reasoningSeen = false;
      let firstDeltaLogged = false;
      const toolCalls: AccumToolCall[] = [];
      const readLine = (line: string) => {
        const value = line.trim();
        if (!value || !value.startsWith('data:')) return;
        const payload = value.slice(5).trim();
        if (!payload) return;
        if (payload === '[DONE]') {
          sawDone = true;
          return;
        }
        let data: any;
        try { data = JSON.parse(payload); } catch { return; }
        if (data.usage) {
          usage = {
            inputTokens: Number(data.usage.prompt_tokens) || 0,
            outputTokens: Number(data.usage.completion_tokens) || 0,
            totalTokens: Number(data.usage.total_tokens) || 0,
          };
          debugLog('USAGE', JSON.stringify(usage));
        }
        const reason = data.choices?.[0]?.finish_reason;
        if (reason) {
          finishReason = reason;
          debugLog('FINISH', reason);
        }
        const delta = data.choices?.[0]?.delta || {};
        if (!firstDeltaLogged) {
          firstDeltaLogged = true;
          debugLog('FIRST_DELTA', JSON.stringify(delta).slice(0, 300));
        }
        const thinkingDelta = delta.reasoning_content || delta.reasoning || '';
        if (thinkingDelta) {
          if (!reasoningSeen) {
            reasoningSeen = true;
            onReasoningStart?.();
          }
          onReasoningText?.(thinkingDelta);
        }
        const contentDelta = delta.content || '';
        if (contentDelta) {
          content += contentDelta;
          onChunk!(contentDelta);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const index = Number.isInteger(part.index) ? part.index : toolCalls.length;
            const existing = toolCalls[index] || (toolCalls[index] = { type: 'function', function: { name: '', arguments: '' } });
            if (part.id) existing.id = part.id;
            if (part.type) existing.type = part.type;
            if (part.function?.name) existing.function.name += part.function.name;
            if (part.function?.arguments) existing.function.arguments += part.function.arguments;
          }
        }
      };

      while (true) {
        const { done, value } = await guarded(reader.read());
        resetTimer();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(readLine);
        if (done) break;
      }
      readLine(buffer);
      debugLog('STREAM_END', JSON.stringify({ sawDone, contentLen: content.length, finishReason }));
      if (!sawDone) {
        const error = new Error('语言模型流式响应在完成前中断') as Error & { code: string };
        error.code = 'LLM_STREAM_INTERRUPTED';
        throw error;
      }
      const collectedToolCalls = toolCalls.filter(Boolean);
      if (!content.trim() && collectedToolCalls.length === 0) {
        debugLog('EMPTY_RESPONSE', JSON.stringify({ sawDone, contentLen: content.length, finishReason, usage }));
        const error = new Error('语言模型返回了空响应') as Error & { code: string; budgetExhausted?: boolean };
        error.code = 'EMPTY_MODEL_RESPONSE';
        if (finishReason === 'length') error.budgetExhausted = true;
        throw error;
      }
      return { role: 'assistant', content, ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls as ChatToolCall[] } : {}), ...(usage ? { usage } : {}), finishReason };
    } finally {
      clearTimeout(timer);
      if (this._controller === controller) this._controller = null;
    }
  }

  cancel(): void {
    this._controller?.abort('cancelled');
  }
}
