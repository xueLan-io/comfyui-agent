export function assertServiceOwner(owner = {}, expected = {}) {
  for (const field of ['principalId', 'projectId', 'sessionId']) {
    if (expected[field] && owner[field] !== expected[field]) {
      const error = new Error(`Service owner mismatch: ${field}`);
      error.code = 'SERVICE_OWNER_MISMATCH';
      throw error;
    }
  }
  return owner;
}

export function assertServicePermission(manifest, action, owner = {}) {
  const permission = manifest?.permissions?.[action];
  if (typeof permission !== 'string' || !permission.trim()) throw Object.assign(new Error(`Service permission is not declared for ${action}`), { code: 'SERVICE_PERMISSION_MISSING' });
  if (!Array.isArray(owner.permissions) || !owner.permissions.includes(permission)) throw Object.assign(new Error(`Service permission is not granted: ${permission}`), { code: 'SERVICE_PERMISSION_DENIED' });
  return permission;
}

export function assertServiceConfirmation(manifest, action, input = {}) {
  const permission = assertServicePermission(manifest, action, input.owner || {});
  if (['invoke', 'cancel', 'archive', 'download'].includes(action) && input.confirmation !== true) {
    const error = new Error(`Explicit confirmation is required for service ${action}`);
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  return permission;
}
