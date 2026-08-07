const ACTIONS = new Set(['prepare', 'invoke', 'status', 'cancel', 'result', 'archive', 'download']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function validateServiceManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['Manifest must be an object'] };
  for (const field of ['contractVersion', 'serviceId', 'name', 'version', 'kind']) if (typeof manifest[field] !== 'string' || !manifest[field]) errors.push(`Missing manifest field: ${field}`);
  try { object(manifest.inputs, 'inputs'); } catch (error) { errors.push(error.message); }
  try { object(manifest.outputs, 'outputs'); } catch (error) { errors.push(error.message); }
  try { object(manifest.execution, 'execution'); } catch (error) { errors.push(error.message); }
  try { object(manifest.permissions, 'permissions'); } catch (error) { errors.push(error.message); }
  if (manifest.execution && (!Number.isFinite(Number(manifest.execution.timeoutMs)) || Number(manifest.execution.timeoutMs) <= 0)) errors.push('execution.timeoutMs must be positive');
  for (const action of ACTIONS) if (manifest.permissions && typeof manifest.permissions[action] !== 'string') errors.push(`Missing permission for action: ${action}`);
  if (manifest.limits !== undefined) {
    try { object(manifest.limits, 'limits'); } catch (error) { errors.push(error.message); }
  }
  return { valid: errors.length === 0, errors };
}

export function assertServiceManifest(manifest) {
  const result = validateServiceManifest(manifest);
  if (!result.valid) throw new Error(`Invalid service manifest: ${result.errors.join('; ')}`);
  return structuredClone(manifest);
}

export function serviceManifest(manifest, service = {}) {
  return { ...assertServiceManifest(manifest), actions: Object.keys(service).filter(action => ACTIONS.has(action) && typeof service[action] === 'function') };
}

export { ACTIONS as SERVICE_ACTIONS };
