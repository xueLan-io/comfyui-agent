import { parseToolCall } from '../core-loop/model/openai-compatible.ts';
import type {
  ChatMessage,
  ChatModel,
  ModelDecision,
  ToolDescriptor,
} from '../core-loop/core/types.ts';

/**
 * Bridge adapter: core-loop `ChatModel` over ComfyMuse's `LLMProvider`.
 *
 * This is the ONLY seam where the new kernel touches the legacy provider layer
 * (agent-v2-design.md §7.2 adapters; the lint gate forbids this direction from
 * inside core-loop itself). The legacy provider keeps owning routing, context
 * fitting, local/cloud policy, and retries; the kernel keeps speaking its own
 * provider-agnostic message shape.
 *
 * Two wire-shape facts drive the mapping:
 *  - Ollama tool calls arrive WITHOUT an id, but the kernel's ToolCall.id is
 *    required (it is echoed back as tool_call_id). Synthesize a stable one.
 *  - Providers emit arguments as a JSON *string*; unparseable arguments must
 *    reach the registry as `rawArguments` so the model gets a precise argument
 *    error instead of a silent drop — parseToolCall from the kernel does this.
 */

/** Minimal structural view of LLMProvider — avoids importing legacy types here. */
export interface BridgeLLM {
  chat(options: Record<string, unknown>): Promise<{
    role?: string;
    content: unknown;
    tool_calls?: Array<{ id?: string; type?: string; function: { name: string; arguments: string } }>;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    finishReason?: string;
  }>;
}

type WireMessage = Record<string, unknown>;

export function toWireMessage(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
    case 'assistant': {
      if (message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: message.content.length > 0 ? message.content : null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
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

export class BridgedChatModel implements ChatModel {
  readonly name: string;
  private readonly llm: BridgeLLM;

  constructor(llm: BridgeLLM, modelName = 'bridged') {
    this.llm = llm;
    this.name = `v2-bridge:${modelName}`;
  }

  async chat(messages: readonly ChatMessage[], tools: readonly ToolDescriptor[]): Promise<ModelDecision> {
    const wireMessages = messages.map(toWireMessage);
    const result = await this.llm.chat({
      messages: wireMessages,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
    });

    const toolCalls = (result.tool_calls ?? []).map((call, index) => {
      const id = call.id ?? `call_${index + 1}_${call.function.name}`;
      return parseToolCall(id, call.function.name, call.function.arguments);
    });

    const usage = result.usage
      ? {
          ...(result.usage.inputTokens !== undefined ? { promptTokens: result.usage.inputTokens } : {}),
          ...(result.usage.outputTokens !== undefined
            ? { completionTokens: result.usage.outputTokens }
            : {}),
          ...(result.usage.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {}),
        }
      : undefined;

    return {
      text: typeof result.content === 'string' ? result.content : '',
      toolCalls,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}
