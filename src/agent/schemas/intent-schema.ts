export type Intent = 'generate' | 'refine' | 'edit' | 'prompt_edit' | 'file_edit' | 'chat' | 'query' | 'cancel';
export type IntentAction = 'reply' | 'clarify' | 'suggest' | 'prepare' | 'execute';
export type IntentTarget = 'new' | 'last_generation' | 'artifact' | 'last_prompt' | 'attached_media' | 'none';
export type ExecutionKind = 'none' | 'txt2img' | 'img2img' | 'inpaint' | 'upscale' | 'video' | 'file_edit';

export const INTENTS: string[] = [
  'generate',
  'refine',
  'edit',
  'prompt_edit',
  'file_edit',
  'chat',
  'query',
  'cancel',
];

export const INTENT_ACTIONS: string[] = ['reply', 'clarify', 'suggest', 'prepare', 'execute'];
export const INTENT_TARGETS: string[] = ['new', 'last_generation', 'artifact', 'last_prompt', 'attached_media', 'none'];
export const EXECUTION_KINDS: string[] = ['none', 'txt2img', 'img2img', 'inpaint', 'upscale', 'video', 'file_edit'];

export interface IntentExecution {
  kind: ExecutionKind;
  needsResearch: boolean;
  needsConfirmation: boolean;
}

export interface IntentDecision {
  intent: Intent;
  action: IntentAction;
  confidence: number;
  target: IntentTarget;
  slots: Record<string, any>;
  execution: IntentExecution;
  missing: string[];
  requiresConfirmation: boolean;
  sourceTurnId: string;
  question: string;
  reason: string;
  source: string;
  request: string;
}

const LEGACY_INTENTS: Record<string, string> = {
  workflow_query: 'query',
  runtime_query: 'query',
};

function clampConfidence(value: unknown, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizeExecution(input: unknown, fallback: unknown = {}): IntentExecution {
  const source = input && typeof input === 'object' ? (input as Record<string, any>) : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? (fallback as Record<string, any>) : {};
  const kind = EXECUTION_KINDS.includes(source.kind) ? source.kind
    : EXECUTION_KINDS.includes(fallbackSource.kind) ? fallbackSource.kind
      : 'none';
  return {
    kind,
    needsResearch: source.needsResearch === true || fallbackSource.needsResearch === true,
    needsConfirmation: source.needsConfirmation === true || fallbackSource.needsConfirmation === true,
  };
}

export function normalizeIntentDecision(input?: unknown, fallback: unknown = {}): IntentDecision {
  const src = input as Record<string, any> | undefined;
  const fb = fallback as Record<string, any>;
  const rawIntent = src?.intent || fb.intent || 'chat';
  const intent = (INTENTS.includes(rawIntent) ? rawIntent : LEGACY_INTENTS[rawIntent] || 'chat') as Intent;
  let action = INTENT_ACTIONS.includes(src?.action)
    ? src!.action
    : intent === 'generate' || intent === 'edit' || intent === 'refine'
      ? 'prepare'
      : 'reply';
  if (['suggest', 'prepare', 'execute'].includes(action) && !['generate', 'edit', 'refine', 'file_edit'].includes(intent)) action = 'reply';
  const missing = Array.isArray(src?.missing)
    ? src!.missing.map(String).filter(Boolean)
    : Array.isArray(fb.missing) ? fb.missing : [];
  const target = src?.target || fb.target;

  return {
    intent,
    action,
    confidence: clampConfidence(src?.confidence, fb.confidence ?? 0),
    target: (INTENT_TARGETS.includes(target) ? target : 'none') as IntentTarget,
    slots: src?.slots && typeof src.slots === 'object' ? src.slots : fb.slots || {},
    execution: normalizeExecution(src?.execution, fb.execution),
    missing,
    requiresConfirmation: src?.requiresConfirmation === true || fb.requiresConfirmation === true,
    sourceTurnId: typeof src?.sourceTurnId === 'string' ? src.sourceTurnId : fb.sourceTurnId || '',
    question: typeof src?.question === 'string' ? src.question.trim() : fb.question || '',
    reason: typeof src?.reason === 'string' ? src.reason.trim() : fb.reason || '',
    source: src?.source || fb.source || 'llm',
    request: typeof src?.request === 'string' ? src.request.trim() : fb.request || '',
  };
}

export function parseIntentDecision(raw = '', fallback: unknown = {}): IntentDecision | null {
  try {
    const cleaned = String(raw).replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return normalizeIntentDecision(JSON.parse(cleaned), fallback);
  } catch {
    return null;
  }
}
