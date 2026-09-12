import type { LogLevel } from '../config/env.ts';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Key names whose values must never reach a log sink. Matched case-insensitively. */
const REDACT_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'token',
  'password',
  'secret',
  'model_api_key',
  'comfy_api_key',
]);

const REDACTED = '[redacted]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))
      ? REDACTED
      : redact(val, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const safe = redact(value);
    const rendered = typeof safe === 'string' ? safe : JSON.stringify(safe);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Leveled logger writing to stderr.
 *
 * stderr specifically: the MCP server speaks JSON-RPC over stdio, so anything on
 * stdout would corrupt the protocol stream.
 */
export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const merged = { ...bindings, ...(meta ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value instanceof Error) merged[key] = serializeError(value);
    }
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${formatMeta(merged)}`;
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

/** A logger that discards everything — used in tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
