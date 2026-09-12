/**
 * Provider-agnostic conversation types.
 *
 * The loop and the context assembler speak only these; provider SDK shapes are
 * confined to `model/openai-compatible.ts`. That is what keeps the model layer
 * swappable (see docs/adr/0001).
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Provider-assigned id, echoed back on the tool result message. */
  id: string;
  name: string;
  /** Raw arguments. Always Zod-validated by the registry before dispatch. */
  arguments: Record<string, unknown>;
  /**
   * Set when the provider emitted arguments that were not valid JSON. The
   * registry reports this as an argument error rather than guessing, because a
   * malformed payload means the model's intent is genuinely unknown.
   */
  rawArguments?: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that request tools. */
  toolCalls?: readonly ToolCall[];
  /** Present on tool messages; the call this result answers. */
  toolCallId?: string;
  toolName?: string;
}

/** What the model returned for one step. */
export interface ModelDecision {
  text: string;
  toolCalls: readonly ToolCall[];
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema 2020-12, generated from the tool's Zod schema. */
  inputSchema: Record<string, unknown>;
}

/** A tool's return value. Errors are values so the model can self-correct. */
export interface ToolResult {
  ok: boolean;
  /** Compacted payload safe to place in context. */
  content: unknown;
  /** Short machine-readable code when ok=false (e.g. "VALIDATION_FAILED"). */
  errorCode?: string;
}

export interface ChatModel {
  readonly name: string;
  chat(messages: readonly ChatMessage[], tools: readonly ToolDescriptor[]): Promise<ModelDecision>;
}
