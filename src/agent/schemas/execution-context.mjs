const GENERATION_INTENTS = new Set(['generate', 'edit', 'refine']);
const TARGETS = new Set(['new', 'last_generation', 'artifact', 'last_prompt', 'attached_media', 'none']);
const MEDIA_SOURCES = new Set(['none', 'attached_media', 'last_generation', 'artifact']);

function clone(value) {
  return value && typeof value === 'object' ? structuredClone(value) : value;
}

export function normalizeExecutionContext(input = {}) {
  const intent = String(input.intent || 'generate');
  const target = TARGETS.has(input.target) && input.target !== 'none'
    ? input.target
    : intent === 'generate'
      ? 'new'
      : input.media?.images?.length || input.media?.masks?.length || input.media?.videos?.length
        ? 'attached_media'
        : intent === 'refine' || intent === 'edit'
          ? 'last_generation'
          : 'none';
  const derivedMediaSource = (
    target === 'attached_media' ? 'attached_media' :
      target === 'last_generation' ? 'last_generation' :
        target === 'artifact' ? 'artifact' : 'none'
  );
  const mediaSource = derivedMediaSource;

  return {
    requestId: input.requestId || '',
    turnId: input.turnId || input.sourceTurnId || '',
    projectId: input.projectId || '',
    sessionId: input.sessionId || '',
    intent,
    action: input.action || (GENERATION_INTENTS.has(intent) ? 'prepare' : 'reply'),
    target,
    request: String(input.request || input.effectiveRequest || ''),
    slots: clone(input.slots) || {},
    missing: Array.isArray(input.missing) ? [...new Set(input.missing.map(String).filter(Boolean))] : [],
    readiness: clone(input.readiness) || null,
    mediaSource,
    media: clone(input.media) || {},
    workflowMode: input.workflowMode || '',
    workflowName: input.workflowName || '',
    requiresConfirmation: input.requiresConfirmation !== false,
    source: input.source || 'agent',
  };
}

export function assertExecutionContext(context = {}) {
  if (!GENERATION_INTENTS.has(context.intent)) {
    throw new Error(`Intent ${context.intent} cannot create a generation execution`);
  }
  if (context.action !== 'prepare' && context.action !== 'execute') {
    throw new Error(`Intent action ${context.action} cannot create a generation execution`);
  }
  if (context.intent === 'generate' && context.target !== 'new') {
    throw new Error('New generation must target new content');
  }
  if (context.intent === 'edit' && !['attached_media', 'last_generation', 'artifact'].includes(context.target)) {
    throw new Error('Image editing requires a reference media target');
  }
  if (context.intent === 'refine' && !['last_generation', 'attached_media', 'artifact'].includes(context.target)) {
    throw new Error('Refinement requires a generation or reference media target');
  }
  if (context.missing?.length > 0) {
    throw new Error(`Execution context is missing: ${context.missing.join(', ')}`);
  }
  if (!MEDIA_SOURCES.has(context.mediaSource)) {
    throw new Error(`Unknown media source ${context.mediaSource}`);
  }
  const expectedMediaSource = ['attached_media', 'last_generation', 'artifact'].includes(context.target)
    ? context.target
    : 'none';
  if (context.mediaSource !== expectedMediaSource) {
    throw new Error(`Execution context target ${context.target} does not match media source ${context.mediaSource}`);
  }
  return context;
}
