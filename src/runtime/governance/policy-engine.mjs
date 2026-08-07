import { assertGovernanceContext, sameGovernanceOwner } from './context.mjs';
import { permissionsForRoles } from './policy-schema.mjs';

export const ERROR_CODES = Object.freeze({ AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED', AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED', OWNER_MISMATCH: 'OWNER_MISMATCH', TENANT_MISMATCH: 'TENANT_MISMATCH', PROJECT_ACCESS_DENIED: 'PROJECT_ACCESS_DENIED', CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED', POLICY_DISABLED: 'POLICY_DISABLED' });

export function createPolicyEngine({ principals = new Map(), policyVersion = '1', disabled = false } = {}) {
  const getPrincipal = id => typeof principals.get === 'function' ? principals.get(id) : principals[id];
  return {
    authorize(context, action, resource = {}, input = {}) {
      if (disabled) return { allowed: false, code: ERROR_CODES.POLICY_DISABLED, reason: 'Policy enforcement is disabled', requiredConfirmation: false, policyVersion, obligations: [] };
      try { assertGovernanceContext(context); } catch (error) { return { allowed: false, code: error.code || ERROR_CODES.AUTHENTICATION_REQUIRED, reason: error.message, requiredConfirmation: false, policyVersion, obligations: [] }; }
      const principal = getPrincipal(context.principalId);
      if (!principal || principal.disabled) return { allowed: false, code: ERROR_CODES.AUTHENTICATION_REQUIRED, reason: 'Principal is not authenticated', requiredConfirmation: false, policyVersion, obligations: [] };
      if (principal.tenantId !== context.tenantId || (resource.tenantId && resource.tenantId !== context.tenantId)) return { allowed: false, code: ERROR_CODES.TENANT_MISMATCH, reason: 'Tenant does not match', requiredConfirmation: false, policyVersion, obligations: [] };
      if (resource.projectId && resource.projectId !== context.projectId) return { allowed: false, code: ERROR_CODES.PROJECT_ACCESS_DENIED, reason: 'Project is outside the governance context', requiredConfirmation: false, policyVersion, obligations: [] };
      if (resource.sessionId && resource.sessionId !== context.sessionId) return { allowed: false, code: ERROR_CODES.OWNER_MISMATCH, reason: 'Session does not own resource', requiredConfirmation: false, policyVersion, obligations: [] };
      if (!permissionsForRoles(principal.roles).has(action)) return { allowed: false, code: ERROR_CODES.AUTHORIZATION_DENIED, reason: `Role does not permit ${action}`, requiredConfirmation: false, policyVersion, obligations: [] };
      const requiredConfirmation = input.confirmation !== true && (input.requiresConfirmation === true || ['workflow.write', 'filesystem.write', 'comfyui.submit', 'comfyui.cancel', 'service.invoke', 'service.cancel', 'service.archive', 'service.download', 'config.write', 'credential.access'].includes(action));
      return { allowed: true, code: requiredConfirmation ? ERROR_CODES.CONFIRMATION_REQUIRED : undefined, reason: requiredConfirmation ? 'Explicit confirmation is required' : 'role_grant', requiredConfirmation, policyVersion, obligations: requiredConfirmation ? ['confirmation'] : [], owner: sameGovernanceOwner(context, { ...context }) };
    },
  };
}
