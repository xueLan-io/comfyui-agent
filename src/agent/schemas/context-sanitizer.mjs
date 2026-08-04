import { basename, win32 } from 'node:path';

const SECRET_KEY = /api[-_]?key|authorization|access[-_]?token|secret|password/i;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g;
const POSIX_PATH = /\/(?:Users|home|root|mnt|private|var|tmp)\/(?:[^/\s"']+\/)*[^/\s"']*/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const NAMED_SECRET = /(["']?(?:api[-_]?key|access[-_]?token|secret|password)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;
const QUOTED_WINDOWS_PATH = /(["'])([A-Za-z]:\\[^"'\r\n]+)\1/g;

function pathLabel(value) {
  const normalized = String(value).replace(/[),.;:]+$/, '');
  return `<local-file:${win32.basename(normalized) || basename(normalized) || 'redacted'}>`;
}

export function sanitizeText(value = '') {
  return String(value)
    .replace(QUOTED_WINDOWS_PATH, (_match, quote, path) => `${quote}${pathLabel(path)}${quote}`)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(OPENAI_KEY, '[REDACTED_API_KEY]')
    .replace(NAMED_SECRET, '$1[REDACTED]')
    .replace(WINDOWS_PATH, pathLabel)
    .replace(POSIX_PATH, pathLabel);
}

export function sanitizeContextValue(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeContextValue(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;

  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/^(workflow|workflowJson|rawWorkflow)$/i.test(childKey) && childValue && typeof childValue === 'object') {
      sanitized[childKey] = '[OMITTED_WORKFLOW]';
      continue;
    }
    sanitized[childKey] = sanitizeContextValue(childValue, childKey, depth + 1);
  }
  return sanitized;
}

export function sanitizeMessages(messages = [], options = {}) {
  const maxMessages = options.maxMessages || 20;
  const maxContent = options.maxContent || 12000;
  const seenToolOutputs = new Set();
  const result = [];

  for (const message of messages.slice(-maxMessages)) {
    if (!message || typeof message !== 'object') continue;
    let content = typeof message.content === 'string'
      ? sanitizeText(message.content)
      : sanitizeMessageContent(message.content);
    if (message.role === 'tool') {
      const signature = typeof content === 'string' ? content.slice(0, 1000) : JSON.stringify(content).slice(0, 1000);
      if (seenToolOutputs.has(signature)) continue;
      seenToolOutputs.add(signature);
    }
    if (typeof content === 'string' && content.length > maxContent) content = `${content.slice(0, maxContent)}\n[TRUNCATED]`;
    result.push({ ...message, content });
  }
  return result;
}

function sanitizeMessageContent(content) {
  if (!Array.isArray(content)) return sanitizeContextValue(content);
  return content.map(part => {
    if (part?.type === 'image_url') return part;
    if (typeof part === 'string') return sanitizeText(part);
    return sanitizeContextValue(part);
  });
}
