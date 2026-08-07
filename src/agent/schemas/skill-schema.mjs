const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MODES = new Set(['txt2img', 'img2img', 'inpaint', 'video', 'upscale']);

export function validateSkillContract(skill) {
  const errors = [];
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return { valid: false, errors: ['Skill must be an object'] };
  for (const field of ['id', 'name', 'description', 'version']) if (typeof skill[field] !== 'string' || !skill[field]) errors.push(`Missing skill field: ${field}`);
  if (skill.id && !ID_PATTERN.test(skill.id)) errors.push('id must match ^[a-z][a-z0-9_-]*$');
  if (skill.keywords !== undefined && (!Array.isArray(skill.keywords) || skill.keywords.some(item => typeof item !== 'string'))) errors.push('keywords must be an array of strings');
  const capabilities = skill.capabilities || {};
  for (const field of ['inputs', 'outputs', 'modes', 'operations', 'sideEffects']) if (capabilities[field] !== undefined && !Array.isArray(capabilities[field])) errors.push(`capabilities.${field} must be an array`);
  for (const mode of capabilities.modes || []) if (!MODES.has(mode)) errors.push(`Unsupported skill mode: ${mode}`);
  const requirements = skill.requirements || {};
  if (requirements.media !== undefined && !Array.isArray(requirements.media)) errors.push('requirements.media must be an array');
  if (requirements.workflowCapabilities !== undefined && !Array.isArray(requirements.workflowCapabilities)) errors.push('requirements.workflowCapabilities must be an array');
  return { valid: errors.length === 0, errors };
}

export function assertSkillContract(skill) {
  const result = validateSkillContract(skill);
  if (!result.valid) throw new Error(`Invalid Skill contract: ${result.errors.join('; ')}`);
  return skill;
}
