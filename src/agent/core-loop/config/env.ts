import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/**
 * Booleans arrive as strings from the environment. Accept the usual spellings
 * instead of silently treating "yes" as false.
 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
    });

const intFromEnv = (defaultValue: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    })
    .pipe(z.number().int().min(min));

const schema = z.object({
  // --- model provider ---
  MODEL_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  MODEL_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  MODEL_API_KEY: z.string().default(''),
  MODEL_NAME: z.string().default('deepseek-chat'),
  MODEL_TEMPERATURE: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? 0.2 : Number(raw)))
    .pipe(z.number().min(0).max(2)),
  MODEL_MAX_TOKENS: intFromEnv(4096),
  MODEL_TIMEOUT_MS: intFromEnv(120_000),

  // --- comfyui ---
  COMFY_BASE_URL: z.string().url().default('http://127.0.0.1:8188'),
  COMFY_API_KEY: z.string().default(''),

  // --- guardrails ---
  AGENT_DRY_RUN: boolFromEnv(true),
  AGENT_MAX_STEPS: intFromEnv(12),
  AGENT_TIMEOUT_MS: intFromEnv(300_000),
  AGENT_NODE_ALLOWLIST: z.string().default(''),

  // --- observability ---
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  TRACE_DIR: z.string().default('traces'),
});

export type LogLevel = z.infer<typeof schema>['LOG_LEVEL'];

export interface ModelConfig {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  name: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ComfyConfig {
  baseUrl: string;
  apiKey: string;
}

export interface GuardrailConfig {
  dryRun: boolean;
  maxSteps: number;
  timeoutMs: number;
  /** Empty means "no allowlist" — every class_type the server knows is permitted. */
  nodeAllowlist: readonly string[];
}

export interface ObservabilityConfig {
  logLevel: LogLevel;
  traceDir: string;
}

export interface AppConfig {
  model: ModelConfig;
  comfy: ComfyConfig;
  guardrails: GuardrailConfig;
  observability: ObservabilityConfig;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Parse configuration exactly once, at startup, so a bad value fails loudly here
 * rather than subtly three tool calls into a run.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  const v = result.data;

  if (v.MODEL_PROVIDER === 'openai' && v.MODEL_API_KEY.trim() === '') {
    throw new ConfigError(
      'MODEL_PROVIDER=openai requires MODEL_API_KEY to be set (see .env.example).',
    );
  }

  const allowlist = v.AGENT_NODE_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    model: {
      provider: v.MODEL_PROVIDER,
      baseUrl: v.MODEL_BASE_URL,
      apiKey: v.MODEL_API_KEY,
      name: v.MODEL_NAME,
      temperature: v.MODEL_TEMPERATURE,
      maxTokens: v.MODEL_MAX_TOKENS,
      timeoutMs: v.MODEL_TIMEOUT_MS,
    },
    comfy: {
      baseUrl: v.COMFY_BASE_URL.replace(/\/+$/, ''),
      apiKey: v.COMFY_API_KEY,
    },
    guardrails: {
      dryRun: v.AGENT_DRY_RUN,
      maxSteps: v.AGENT_MAX_STEPS,
      timeoutMs: v.AGENT_TIMEOUT_MS,
      nodeAllowlist: allowlist,
    },
    observability: {
      logLevel: v.LOG_LEVEL,
      traceDir: v.TRACE_DIR,
    },
  };
}
