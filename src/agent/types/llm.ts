// Shared LLM message contract for the chat pipeline (chat-request assembly,
// provider fitting, context sanitizing). Shapes follow the OpenAI
// chat-completions wire format; extra vendor fields pass through.

export interface ChatToolCallFunction {
  name?: string;
  arguments?: string;
}

export interface ChatToolCall {
  id?: string;
  type?: 'function';
  function?: ChatToolCallFunction;
  index?: number;
  [key: string]: unknown;
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export type ChatContentPart = ChatTextPart | ChatImageUrlPart;

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  [key: string]: unknown;
}
