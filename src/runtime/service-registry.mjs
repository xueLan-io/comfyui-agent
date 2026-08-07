import { assertServiceManifest, serviceManifest } from './service-contract.mjs';

export function createServiceRegistry(services = []) {
  const byId = new Map();
  for (const service of services) {
    const manifest = assertServiceManifest(service.manifest);
    if (byId.has(manifest.serviceId)) throw new Error(`Duplicate serviceId: ${manifest.serviceId}`);
    byId.set(manifest.serviceId, { ...service, manifest });
  }
  return {
    register(service) { const manifest = assertServiceManifest(service.manifest); if (byId.has(manifest.serviceId)) throw new Error(`Duplicate serviceId: ${manifest.serviceId}`); const value = { ...service, manifest }; byId.set(manifest.serviceId, value); return value; },
    unregister(id) { return byId.delete(String(id)); },
    all: () => [...byId.values()],
    byId,
     get: id => { const service = byId.get(id) || null; return service?.enabled === false ? null : service; },
    list: ({ kind, permission, enabled = true } = {}) => [...byId.values()]
      .filter(service => enabled === false || service.enabled !== false)
      .filter(service => !kind || service.manifest.kind === kind)
      .filter(service => !permission || Object.values(service.manifest.permissions || {}).includes(permission))
      .map(service => serviceManifest(service.manifest, service)),
    manifest: id => {
      const service = byId.get(id);
      return service ? serviceManifest(service.manifest, service) : null;
    },
    resolve: (id, action) => {
      const service = byId.get(id);
      if (!service) return null;
      if (typeof service[action] !== 'function') return null;
      return service[action].bind(service);
    },
  };
}
