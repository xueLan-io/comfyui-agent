export interface SkillCapabilities {
  inputs?: string[];
  outputs?: string[];
  modes?: string[];
  operations?: string[];
  sideEffects?: string[];
  [key: string]: unknown;
}

export interface SkillRequirements {
  media?: string[];
  workflowCapabilities?: string[];
  [key: string]: unknown;
}

export interface SkillContract {
  id: string;
  name: string;
  description: string;
  version: string;
  keywords?: string[];
  capabilities?: SkillCapabilities;
  requirements?: SkillRequirements;
  [key: string]: unknown;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MODES = new Set(['txt2img', 'img2img', 'inpaint', 'video', 'upscale']);

export function validateSkillContract(skill: unknown): SkillValidationResult {
  const errors: string[] = [];
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return { valid: false, errors: ['Skill must be an object'] };
  const s = skill as Record<string, unknown>;
  for (const field of ['id', 'name', 'description', 'version']) if (typeof s[field] !== 'string' || !s[field]) errors.push(`Missing skill field: ${field}`);
  if (s.id && !ID_PATTERN.test(s.id as string)) errors.push('id must match ^[a-z][a-z0-9_-]*$');
  if (s.keywords !== undefined && (!Array.isArray(s.keywords) || (s.keywords as unknown[]).some(item => typeof item !== 'string'))) errors.push('keywords must be an array of strings');
  const capabilities = (s.capabilities || {}) as Record<string, unknown>;
  for (const field of ['inputs', 'outputs', 'modes', 'operations', 'sideEffects']) if (capabilities[field] !== undefined && !Array.isArray(capabilities[field])) errors.push(`capabilities.${field} must be an array`);
  for (const mode of (capabilities.modes as string[]) || []) if (!MODES.has(mode)) errors.push(`Unsupported skill mode: ${mode}`);
  const requirements = (s.requirements || {}) as Record<string, unknown>;
  if (requirements.media !== undefined && !Array.isArray(requirements.media)) errors.push('requirements.media must be an array');
  if (requirements.workflowCapabilities !== undefined && !Array.isArray(requirements.workflowCapabilities)) errors.push('requirements.workflowCapabilities must be an array');
  return { valid: errors.length === 0, errors };
}

export function assertSkillContract(skill: unknown): SkillContract {
  const result = validateSkillContract(skill);
  if (!result.valid) throw new Error(`Invalid Skill contract: ${result.errors.join('; ')}`);
  return skill as SkillContract;
}
