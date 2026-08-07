import { createPluginRegistry } from './plugin-registry.mjs';
import { createToolRegistry } from '../../agent/tools/registry.mjs';
import { createServiceRegistry } from '../service-registry.mjs';
import { createSkillRegistry } from '../../agent/skills/registry.mjs';

export function createPluginHost({ tools = [], services = [], skills = {}, plugins = [], ipc = {}, ui = {} } = {}) {
  const toolRegistry = createToolRegistry({ tools });
  const serviceRegistry = createServiceRegistry(services);
  const skillRegistry = createSkillRegistry(skills);
  const registered = new Map();
  const host = {
    registerTool(tool, pluginId) { const value = toolRegistry.register(tool); registered.set(`${pluginId}:tool:${value.name}`, ['tool', value.name]); return value; },
    registerService(service, pluginId) { const value = serviceRegistry.register(service); registered.set(`${pluginId}:service:${value.manifest.serviceId}`, ['service', value.manifest.serviceId]); return value; },
    registerSkill(skill, pluginId) { const value = skillRegistry.add(skill); registered.set(`${pluginId}:skill:${value.id}`, ['skill', value.id]); return value; },
    registerIpc: ipc.register,
    registerUi: ui.register,
  };
  const registry = createPluginRegistry({ host, plugins });
  async function remove(id) {
    const plugin = registry.get(id); if (!plugin) return false;
    await registry.stop(id);
    for (const [key, owner] of registered) {
      if (!key.startsWith(`${plugin.manifest.pluginId}:`)) continue;
      if (owner[0] === 'tool') toolRegistry.unregister(owner[1]);
      if (owner[0] === 'service') serviceRegistry.unregister(owner[1]);
      if (owner[0] === 'skill') skillRegistry.unregister(owner[1]);
      registered.delete(key);
    }
    return registry.remove(id);
  }
  return { registry, toolRegistry, serviceRegistry, skillRegistry, remove };
}
