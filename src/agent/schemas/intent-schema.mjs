export const INTENTS = [
  'generate',
  'refine',
  'edit',
  'prompt_edit',
  'file_edit',
  'chat',
  'query',
  'cancel',
];

export const INTENT_ACTIONS = ['reply', 'clarify', 'suggest', 'prepare', 'execute'];
export const INTENT_TARGETS = ['new', 'last_generation', 'artifact', 'last_prompt', 'attached_media', 'none'];
export const EXECUTION_KINDS = ['none', 'txt2img', 'img2img', 'inpaint', 'upscale', 'video', 'file_edit'];

const LEGACY_INTENTS = {
  workflow_query: 'query',
  runtime_query: 'query',
};

function clampConfidence(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizeExecution(input, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};
  const kind = EXECUTION_KINDS.includes(source.kind) ? source.kind
    : EXECUTION_KINDS.includes(fallbackSource.kind) ? fallbackSource.kind
      : 'none';
  return {
    kind,
    needsResearch: source.needsResearch === true || fallbackSource.needsResearch === true,
    needsConfirmation: source.needsConfirmation === true || fallbackSource.needsConfirmation === true,
  };
}

export function normalizeIntentDecision(input, fallback = {}) {
  const rawIntent = input?.intent || fallback.intent || 'chat';
  const intent = INTENTS.includes(rawIntent) ? rawIntent : LEGACY_INTENTS[rawIntent] || 'chat';
  let action = INTENT_ACTIONS.includes(input?.action)
    ? input.action
    : intent === 'generate' || intent === 'edit' || intent === 'refine'
      ? 'prepare'
      : 'reply';
  if (['suggest', 'prepare', 'execute'].includes(action) && !['generate', 'edit', 'refine', 'file_edit'].includes(intent)) action = 'reply';
  const missing = Array.isArray(input?.missing)
    ? input.missing.map(String).filter(Boolean)
    : Array.isArray(fallback.missing) ? fallback.missing : [];
  const target = input?.target || fallback.target;

  return {
    intent,
    action,
    confidence: clampConfidence(input?.confidence, fallback.confidence ?? 0),
    target: INTENT_TARGETS.includes(target) ? target : 'none',
    slots: input?.slots && typeof input.slots === 'object' ? input.slots : fallback.slots || {},
    execution: normalizeExecution(input?.execution, fallback.execution),
    missing,
    requiresConfirmation: input?.requiresConfirmation === true || fallback.requiresConfirmation === true,
    sourceTurnId: typeof input?.sourceTurnId === 'string' ? input.sourceTurnId : fallback.sourceTurnId || '',
    question: typeof input?.question === 'string' ? input.question.trim() : fallback.question || '',
    reason: typeof input?.reason === 'string' ? input.reason.trim() : fallback.reason || '',
    source: input?.source || fallback.source || 'llm',
    request: typeof input?.request === 'string' ? input.request.trim() : fallback.request || '',
  };
}

export function parseIntentDecision(raw = '', fallback = {}) {
  try {
    const cleaned = String(raw).replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return normalizeIntentDecision(JSON.parse(cleaned), fallback);
  } catch {
    return null;
  }
}
