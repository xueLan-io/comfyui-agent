import OpenAI from 'openai';

import type { ModelConfig } from '../config/env.ts';
import type { ChatMessage, ChatModel, ModelDecision, ToolCall } from '../core/types.ts';
import { ComfyError } from '../comfy/errors.ts';

/**
 * Adapter for any OpenAI-compatible chat-completions endpoint.
 *
 * One implementation covers DeepSeek, Qwen/DashScope, Zhipu GLM, Moonshot Kimi,
 * vLLM, Ollama, LM Studio, and OpenAI itself — only `base_url` and `model` change.
 * Provider wire shapes are confined to this file; everything upstream speaks
 * `ChatModel` (docs/adr/0001).
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(config: ModelConfig) {
    this.name = `openai-compatible:${config.name}`;
    this.model = config.name;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 2,
    });
  }

  async chat(
    messages: readonly ChatMessage[],
    tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[],
  ): Promise<ModelDecision> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: messages.map(toOpenAiMessage),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      });
    } catch (error) {
      throw new ComfyError(
        'MODEL_REQUEST_FAILED',
        `Model request to ${this.model} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
        undefined,
        'Check MODEL_BASE_URL, MODEL_API_KEY, and MODEL_NAME, and confirm the endpoint is reachable.',
      );
    }

    const choice = completion.choices[0];
    const message = choice?.message;
    if (!message) {
      return { text: '', toolCalls: [] };
    }

    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((call): call is typeof call & { type: 'function' } => call.type === 'function')
      .map((call) => parseToolCall(call.id, call.function.name, call.function.arguments));

    // Some providers emit both a preamble and tool calls; keep the text either
    // way so the reasoning trail survives into the trace.
    const text = typeof message.content === 'string' ? message.content : '';

    return {
      text,
      toolCalls,
      usage: {
        ...(completion.usage?.prompt_tokens !== undefined
          ? { promptTokens: completion.usage.prompt_tokens } : {}),
        ...(completion.usage?.completion_tokens !== undefined
          ? { completionTokens: completion.usage.completion_tokens } : {}),
        ...(completion.usage?.total_tokens !== undefined
          ? { totalTokens: completion.usage.total_tokens } : {}),
      },
    };
  }
}

/**
 * Parse a tool call's arguments defensively.
 *
 * Models occasionally emit empty, truncated, or non-JSON arguments. Rather than
 * dropping the call (the model would silently never learn) or throwing (the run
 * would abort on a recoverable mistake), we preserve the raw text so the
 * registry can report a precise argument error and the model can retry.
 */
export function parseToolCall(
  id: string,
  name: string,
  rawArguments: string | undefined,
): ToolCall {
  const raw = rawArguments ?? '';
  if (raw.trim() === '') {
    return { id, name, arguments: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { id, name, arguments: parsed as Record<string, unknown> };
    }
    // Valid JSON but not an object — the schema will reject it meaningfully.
    return { id, name, arguments: {}, rawArguments: raw };
  } catch {
    return { id, name, arguments: {}, rawArguments: raw };
  }
}

type OpenAiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Translate our provider-agnostic message into the OpenAI wire shape. */
export function toOpenAiMessage(message: ChatMessage): OpenAiMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'tool':
      return {
        role: 'tool',
        // The wire format requires the id of the call this result answers.
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };
    case 'assistant': {
      if (message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: message.content.length > 0 ? message.content : null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: call.rawArguments ?? JSON.stringify(call.arguments),
            },
          })),
        };
      }
      return { role: 'assistant', content: message.content };
    }
    default: {
      const exhaustive: never = message.role;
      throw new Error(`Unhandled message role: ${String(exhaustive)}`);
    }
  }
}
