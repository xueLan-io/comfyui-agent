import { basename, win32 } from 'node:path';
import type { ChatMessage } from '../types/llm.ts';

const SECRET_KEY = /api[-_]?key|authorization|access[-_]?token|secret|password/i;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g;
const POSIX_PATH = /\/(?:Users|home|root|mnt|private|var|tmp)\/(?:[^/\s"']+\/)*[^/\s"']*/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const NAMED_SECRET = /(["']?(?:api[-_]?key|access[-_]?token|secret|password)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;
const QUOTED_WINDOWS_PATH = /(["'])([A-Za-z]:\\[^"'\r\n]+)\1/g;

export interface SanitizeMessagesOptions {
  maxMessages?: number;
  maxContent?: number;
}

function pathLabel(value: unknown): string {
  const normalized = String(value).replace(/[),.;:]+$/, '');
  return `<local-file:${win32.basename(normalized) || basename(normalized) || 'redacted'}>`;
}

export function sanitizeText(value: unknown = ''): string {
  return String(value)
    .replace(QUOTED_WINDOWS_PATH, (_match, quote, path) => `${quote}${pathLabel(path)}${quote}`)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(OPENAI_KEY, '[REDACTED_API_KEY]')
    .replace(NAMED_SECRET, '$1[REDACTED]')
    .replace(WINDOWS_PATH, pathLabel)
    .replace(POSIX_PATH, pathLabel);
}

export function sanitizeContextValue(value: any, key = '', depth = 0): any {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeContextValue(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, any> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/^(workflow|workflowJson|rawWorkflow)$/i.test(childKey) && childValue && typeof childValue === 'object') {
      sanitized[childKey] = '[OMITTED_WORKFLOW]';
      continue;
    }
    sanitized[childKey] = sanitizeContextValue(childValue, childKey, depth + 1);
  }
  return sanitized;
}

export function sanitizeMessages(messages: ChatMessage[] = [], options: SanitizeMessagesOptions = {}): ChatMessage[] {
  const maxMessages = Math.max(1, options.maxMessages || 20);
  const maxContent = options.maxContent || 12000;
  const seenToolOutputs = new Set<string>();
  const result: ChatMessage[] = [];

  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem]?.role === 'system') firstNonSystem += 1;
  const systemMessages = messages.slice(0, firstNonSystem);
  const windowSize = Math.max(1, maxMessages - systemMessages.length);
  const windowed = [...systemMessages, ...messages.slice(firstNonSystem).slice(-windowSize)];

  for (const message of windowed) {
    if (!message || typeof message !== 'object') continue;
    let content: unknown = typeof message.content === 'string'
      ? sanitizeText(message.content)
      : sanitizeMessageContent(message.content);
    if (message.role === 'tool') {
      const signature = typeof content === 'string' ? content.slice(0, 1000) : JSON.stringify(content).slice(0, 1000);
      if (seenToolOutputs.has(signature)) {
        result.push({ ...message, content: '[duplicate tool output omitted]' });
        continue;
      }
      seenToolOutputs.add(signature);
    }
    if (typeof content === 'string' && content.length > maxContent) content = `${content.slice(0, maxContent)}\n[TRUNCATED]`;
    result.push({ ...message, content } as ChatMessage);
  }
  return result;
}

function sanitizeMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return sanitizeContextValue(content);
  return content.map((part: any) => {
    if (part?.type === 'image_url') return part;
    if (typeof part === 'string') return sanitizeText(part);
    return sanitizeContextValue(part);
  });
}
