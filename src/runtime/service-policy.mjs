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

export function assertServiceConfirmation(manifest, action, input = {}) {
  const permission = manifest.permissions?.[action];
  if (['invoke', 'cancel', 'archive', 'download'].includes(action) && input.confirmation !== true) {
    const error = new Error(`Explicit confirmation is required for service ${action}`);
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  return permission;
}
