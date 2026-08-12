import { normalizeSkill } from './skill-contract.mjs';
import { matchSkills } from './matcher.mjs';

export function createSkillRegistry({ builtin = {}, custom = [], external = [] } = {}) {
  const byId = new Map();
  const add = (skill, id) => { const normalized = normalizeSkill(skill, id); if (byId.has(normalized.id)) throw new Error(`Duplicate Skill ID: ${normalized.id}`); if (normalized.enabled !== false) byId.set(normalized.id, normalized); };
  for (const [id, skill] of Object.entries(builtin)) add(skill, id);
  for (const skill of [...custom, ...external]) add(skill);
  return {
    add(skill, id) { add(skill, id); return byId.get(normalizeSkill(skill, id).id); },
    unregister(id) { return byId.delete(String(id)); },
    all: () => [...byId.values()],
    get: id => byId.get(String(id)) || null,
    resolve: id => byId.get(String(id)) || null,
    list: ({ enabled = true } = {}) => [...byId.values()].filter(skill => !enabled || skill.enabled !== false),
    manifest: ({ enabled = true } = {}) => [...byId.values()].filter(skill => !enabled || skill.enabled !== false).map(skill => ({ id: skill.id, name: skill.name, description: skill.description, aliases: skill.aliases || [], version: skill.version, keywords: skill.keywords, capabilities: skill.capabilities, requirements: skill.requirements, external: skill.external === true, enabled: skill.enabled !== false })),
    candidates: (request, context) => matchSkills([...byId.values()], request, context).candidates,
    match: (request, context) => matchSkills([...byId.values()], request, context),
    validate: skill => normalizeSkill(skill),
  };
}
