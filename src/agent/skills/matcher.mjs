import { normalizeSkill } from './skill-contract.mjs';
import { resolveSkillCompatibility } from './compatibility.mjs';

function scoreSkill(skill, request, context = {}, explicitId = '') {
  const text = typeof request === 'string' ? request : String(request.userIntent || request.goal || '');
  const handle = skill.canHandle(request, context) || {};
  const explicit = explicitId && skill.id === explicitId ? 1 : 0;
  const keywords = (skill.keywords || []).filter(keyword => text.toLowerCase().includes(String(keyword).toLowerCase())).length;
  const compatibility = resolveSkillCompatibility({ skill, request, workflowManifest: context.workflowManifest, runtimeCapabilities: context.runtimeCapabilities, resourceEstimate: context.resourceEstimate, context });
  const score = Math.max(0, Math.min(1, (explicit * 0.2) + (Math.min(1, keywords / Math.max(1, (skill.keywords || []).length)) * 0.35) + (Number(handle.score) || 0) * 0.45 + compatibility.scoreAdjustment));
  return { skillId: skill.id, skill, score, confidence: Number(handle.confidence) || score, missing: [...(handle.missing || []), ...compatibility.missing], blockers: compatibility.blockers, warnings: compatibility.warnings, reasons: handle.reasons || [] };
}

export function matchSkills(skills, request, context = {}) {
  const explicitId = String(context.skillId || (typeof request === 'object' ? request.skillId : '') || '').toLowerCase();
  const candidates = skills.map(skill => scoreSkill(skill, request, context, explicitId)).filter(candidate => candidate.score > 0 || candidate.skillId === explicitId).sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId));
  const selected = candidates[0] || null;
  let clarification = null;
  if (selected?.missing?.length) clarification = { action: 'clarify', skillId: selected.skillId, question: `请提供所需的${selected.missing[0]}。`, missing: selected.missing, confidence: selected.confidence, reason: 'required_media_missing' };
  else if (candidates.length > 1 && candidates[1].score >= selected.score - 0.08 && !explicitId) clarification = { action: 'clarify', skillId: selected.skillId, question: `你希望使用${selected.skill.name}，还是${candidates[1].skill.name}？`, candidates: [selected.skillId, candidates[1].skillId], confidence: selected.confidence, reason: 'ambiguous_skill' };
  return { selected: selected ? { skillId: selected.skillId, score: selected.score, confidence: selected.confidence } : null, candidates, clarification };
}
