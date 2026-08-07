export function resolveSkillCompatibility({ skill, request = '', workflowManifest = {}, runtimeCapabilities = {}, resourceEstimate = null, context = {} } = {}) {
  const missing = []; const warnings = []; const blockers = [];
  const media = context.attachedMedia || context.media || {};
  for (const requirement of skill.requirements?.media || []) {
    const values = media[`${requirement.type}s`] || media[requirement.type] || [];
    const count = Array.isArray(values) ? values.length : values ? 1 : 0;
    if (requirement.required && count < (requirement.minCount || 1)) missing.push(`${requirement.type}_media`);
  }
  const requiredCapabilities = skill.requirements?.workflowCapabilities || [];
  const workflowCapabilities = workflowManifest.capabilities?.modes || workflowManifest.capabilities || [];
  for (const capability of requiredCapabilities) if (!workflowCapabilities.includes(capability)) blockers.push(`workflow_capability:${capability}`);
  if (skill.requirements?.runtime?.requiresFfmpeg && runtimeCapabilities.ffmpeg?.available === false) blockers.push('ffmpeg');
  if (resourceEstimate?.issues?.length) warnings.push(...resourceEstimate.issues.map(issue => issue.code || 'resource_warning'));
  return { compatible: missing.length === 0 && blockers.length === 0, missing, warnings, blockers, scoreAdjustment: blockers.length ? -0.35 : warnings.length ? -0.05 : 0, recommendedWorkflow: context.workflowName || '', recommendedModel: null };
}
