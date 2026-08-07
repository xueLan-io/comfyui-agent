const LIFECYCLE = new Set(['start', 'stop']);
const CAPABILITIES = new Set(['tools', 'services', 'skills', 'ipc', 'ui']);

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function validatePluginManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return { valid: false, errors: ['Manifest must be an object'] };
  for (const field of ['contractVersion', 'pluginId', 'name', 'version']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) errors.push(`Missing manifest field: ${field}`);
  }
  if (manifest.capabilities !== undefined && (!Array.isArray(manifest.capabilities) || manifest.capabilities.some(item => !CAPABILITIES.has(item)))) {
    errors.push(`capabilities must contain only: ${[...CAPABILITIES].join(', ')}`);
  }
  if (manifest.permissions !== undefined && !isObject(manifest.permissions)) errors.push('permissions must be an object');
  if (isObject(manifest.permissions)) {
    for (const [capability, permission] of Object.entries(manifest.permissions)) {
      if (!CAPABILITIES.has(capability)) errors.push(`Unknown capability permission: ${capability}`);
      if (typeof permission !== 'string' || !permission) errors.push(`Invalid permission for capability: ${capability}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertPluginManifest(manifest) {
  const result = validatePluginManifest(manifest);
  if (!result.valid) throw new Error(`Invalid plugin manifest: ${result.errors.join('; ')}`);
  return structuredClone({ capabilities: [], permissions: {}, ...manifest });
}

export function assertPluginLifecycle(name) {
  if (!LIFECYCLE.has(name)) throw new Error(`Unsupported plugin lifecycle hook: ${name}`);
  return name;
}

export { CAPABILITIES as PLUGIN_CAPABILITIES, LIFECYCLE as PLUGIN_LIFECYCLE };
