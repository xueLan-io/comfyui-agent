import { validateToolDefinition, toolContract } from '../schemas/tool-schema.mjs';

const DEFAULT_CATEGORIES = ['generation', 'enhancement', 'filesystem', 'management', 'web', 'workflow', 'runtime', 'queue', 'model', 'media', 'service'];

function normalizeOptions(options = {}) {
  return {
    category: options.category || options.categories,
    permission: options.permission,
    surface: options.surface,
    tags: options.tags,
    include: options.include,
    exclude: options.exclude,
  };
}

function matches(tool, options) {
  const { category, permission, surface, tags, include, exclude } = normalizeOptions(options);
  const categories = Array.isArray(category) ? category : category ? [category] : [];
  if (categories.length > 0 && !categories.includes(tool.category)) return false;
  const toolPermission = tool.permission || (tool.requires_confirmation ? 'execute' : 'read');
  if (permission && toolPermission !== permission) return false;
  if (surface && Array.isArray(tool.surfaces) && !tool.surfaces.includes(surface)) return false;
  if (Array.isArray(tags) && tags.length > 0 && !tags.every(tag => (tool.tags || []).includes(tag))) return false;
  if (Array.isArray(include) && include.length > 0 && !include.includes(tool.name)) return false;
  if (Array.isArray(exclude) && exclude.includes(tool.name)) return false;
  return true;
}

export function validateUniqueNames(tools = []) {
  const seen = new Set();
  const errors = [];
  for (const tool of tools) {
    if (seen.has(tool?.name)) errors.push(`Duplicate tool name: ${tool.name}`);
    seen.add(tool?.name);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return true;
}

export function validateToolDefinitions(tools = []) {
  const errors = [];
  for (const tool of tools) {
    const result = validateToolDefinition(tool);
    if (!result.valid) errors.push(`${tool?.name || '(unnamed)'}: ${result.errors.join(', ')}`);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return true;
}

export function createToolRegistry({ tools = [], ...groups } = {}) {
  const grouped = DEFAULT_CATEGORIES.flatMap(category => {
    const value = groups[category] || groups[`${category}Tools`];
    return Array.isArray(value) ? value : value ? [value] : [];
  });
  const all = [...grouped, ...tools];
  validateUniqueNames(all);
  validateToolDefinitions(all);
  const byName = Object.fromEntries(all.map(tool => [tool.name, tool]));
  return {
    register(tool) {
      validateUniqueNames([...all, tool]);
      validateToolDefinitions([tool]);
      all.push(tool); byName[tool.name] = tool; return tool;
    },
    unregister(name) { const index = all.findIndex(tool => tool.name === name); if (index < 0) return false; all.splice(index, 1); delete byName[name]; return true; },
    all,
    byName,
    get: name => byName[name],
    list: options => all.filter(tool => matches(tool, options)),
    contracts: options => all.filter(tool => matches(tool, options)).map(toolContract),
    manifest: options => all.filter(tool => matches(tool, options)).map(tool => ({
      name: tool.name,
      description: tool.description,
      category: tool.category || 'management',
      tags: [...(tool.tags || [])],
      permission: tool.permission || (tool.requires_confirmation ? 'execute' : 'read'),
      risk_level: tool.risk_level || (tool.requires_confirmation ? 'medium' : 'none'),
      output_types: [...(tool.output_types || [])],
    })),
  };
}

export function registryFromTools(tools = []) {
  return createToolRegistry({ tools });
}
