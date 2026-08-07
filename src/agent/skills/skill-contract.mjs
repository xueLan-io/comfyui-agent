import { validateSkillContract } from '../schemas/skill-schema.mjs';

function defaultHandle(request = '', context = {}, skill) {
  const text = typeof request === 'string' ? request : String(request.userIntent || request.goal || '');
  const keywords = (skill.keywords || []).map(item => String(item).toLowerCase());
  const hits = keywords.filter(keyword => text.toLowerCase().includes(keyword)).length;
  return { score: hits ? Math.min(1, 0.35 + hits * 0.2) : 0, confidence: hits ? 0.7 : 0, missing: [], reasons: hits ? ['keyword match'] : [] };
}

function defaultPreview(plan, skill) {
  return { kind: 'generation', summary: `Use ${skill.name || skill.id}`, workflow: plan?.steps?.find(step => step.tool === 'comfyui')?.input?.workflowName || '', requiredMedia: [], changes: [], warnings: [] };
}

function defaultSuccess(result, skill) {
  const expected = skill.capabilities?.outputs || ['images'];
  const ok = expected.includes('videos') ? Boolean(result?.videos?.length) : Boolean(result?.images?.length || result?.media?.length);
  return { ok, reason: ok ? '' : 'No expected media output' };
}

export function normalizeSkill(skill, id = skill?.id) {
  const normalized = { ...skill, id: id || skill?.id || skill?.name, name: skill?.name || id, description: skill?.description || '', version: skill?.version || '1.0.0', keywords: Array.isArray(skill?.keywords) ? [...skill.keywords] : [] };
  if (skill?.external && skill?.declarative) normalized.steps = undefined;
  normalized.canHandle = skill?.canHandle || ((request, context) => defaultHandle(request, context, normalized));
  normalized.plan = skill?.plan || ((request, context = {}) => ({ goal: typeof request === 'string' ? request : request.userIntent || request.goal || '', steps: typeof skill?.steps === 'function' ? skill.steps(typeof request === 'string' ? request : request.userIntent || request, context) : [] }));
  normalized.preview = skill?.preview || (plan => defaultPreview(plan, normalized));
  normalized.success = skill?.success || (result => defaultSuccess(result, normalized));
  normalized.capabilities = { inputs: ['prompt'], outputs: ['images'], modes: [], operations: ['generation'], sideEffects: ['comfyui_generation'], requiresConfirmation: true, ...(skill?.capabilities || {}) };
  normalized.requirements = { media: [], workflowCapabilities: [], models: [], runtime: {}, ...(skill?.requirements || {}) };
  const validation = validateSkillContract(normalized);
  if (!validation.valid) throw new Error(`Invalid Skill contract: ${validation.errors.join('; ')}`);
  return normalized;
}

export function legacySkillAdapter(skill, id) { return normalizeSkill(skill, id); }
