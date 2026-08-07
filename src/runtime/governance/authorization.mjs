import { assertGovernanceContext } from './context.mjs';
export function authorize(engine, context, action, resource, input) { return engine.authorize(context, action, resource, input); }
export function assertAuthorized(decision) {
  if (!decision?.allowed) throw Object.assign(new Error(decision?.reason || 'Authorization denied'), { code: decision?.code || 'AUTHORIZATION_DENIED', decision });
  if (decision.requiredConfirmation) throw Object.assign(new Error(decision.reason || 'Explicit confirmation is required'), { code: 'CONFIRMATION_REQUIRED', decision });
  return decision;
}
export function requireAuthorized(engine, context, action, resource, input) { assertGovernanceContext(context); return assertAuthorized(authorize(engine, context, action, resource, input)); }
