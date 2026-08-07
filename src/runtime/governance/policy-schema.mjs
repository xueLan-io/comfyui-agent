export const ACTIONS = Object.freeze([
  'project.read', 'project.write', 'session.read', 'session.write', 'workflow.read', 'workflow.write',
  'filesystem.read', 'filesystem.write', 'media.read', 'media.export', 'network.search', 'network.open',
  'llm.invoke', 'comfyui.submit', 'comfyui.observe', 'comfyui.cancel', 'service.prepare', 'service.invoke',
  'service.status', 'service.result', 'service.cancel', 'service.archive', 'service.download', 'audit.read', 'trace.read',
  'config.read', 'config.write', 'admin.recover', 'retention.manage', 'credential.access',
]);

export const ROLES = Object.freeze(['viewer', 'operator', 'editor', 'auditor', 'admin']);
export const ROLE_ACTIONS = Object.freeze({
  viewer: ['project.read', 'session.read', 'workflow.read', 'media.read', 'service.status', 'service.result', 'audit.read'],
  operator: ['service.prepare', 'service.invoke', 'service.cancel', 'comfyui.submit', 'comfyui.observe', 'comfyui.cancel'],
  editor: ['workflow.write', 'filesystem.write'],
  auditor: ['trace.read'],
  admin: ['config.write', 'admin.recover', 'retention.manage', 'credential.access'],
});

export function permissionsForRoles(roles = []) {
  const permissions = new Set();
  if (roles.includes('admin')) return new Set(ACTIONS);
  for (const role of roles) for (const action of ROLE_ACTIONS[role] || []) permissions.add(action);
  if (roles.includes('operator') || roles.includes('editor') || roles.includes('admin')) for (const action of ROLE_ACTIONS.viewer) permissions.add(action);
  if (roles.includes('editor')) for (const action of ROLE_ACTIONS.operator) permissions.add(action);
  return permissions;
}
