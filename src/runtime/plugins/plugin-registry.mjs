import { assertPluginManifest, PLUGIN_CAPABILITIES } from './plugin-contract.mjs';

function normalizePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') throw new Error('Plugin must be an object');
  const manifest = assertPluginManifest(plugin.manifest);
  const declared = new Set(manifest.capabilities);
  for (const capability of PLUGIN_CAPABILITIES) {
    if (typeof plugin[capability] === 'function' && !declared.has(capability)) throw new Error(`Plugin ${manifest.pluginId} exposes undeclared capability: ${capability}`);
  }
  return { ...plugin, manifest, state: 'registered' };
}

export function createPluginRegistry({ host = {}, plugins = [] } = {}) {
  const byId = new Map();
  const add = plugin => {
    const normalized = normalizePlugin(plugin);
    if (byId.has(normalized.manifest.pluginId)) throw new Error(`Duplicate pluginId: ${normalized.manifest.pluginId}`);
    byId.set(normalized.manifest.pluginId, normalized);
    return normalized.manifest.pluginId;
  };
  for (const plugin of plugins) add(plugin);

  function get(id) { return byId.get(String(id)) || null; }
  function contextFor(plugin) {
    const allowed = new Set(plugin.manifest.capabilities);
    return Object.freeze({
      pluginId: plugin.manifest.pluginId,
      manifest: structuredClone(plugin.manifest),
      host: Object.freeze({
        registerTool: allowed.has('tools') ? value => host.registerTool?.(value, plugin.manifest.pluginId) : undefined,
        registerService: allowed.has('services') ? value => host.registerService?.(value, plugin.manifest.pluginId) : undefined,
        registerSkill: allowed.has('skills') ? value => host.registerSkill?.(value, plugin.manifest.pluginId) : undefined,
        registerIpc: allowed.has('ipc') ? value => host.registerIpc?.(value, plugin.manifest.pluginId) : undefined,
        registerUi: allowed.has('ui') ? value => host.registerUi?.(value, plugin.manifest.pluginId) : undefined,
      }),
    });
  }
  async function start(id) {
    const plugin = get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (plugin.state === 'started') return plugin.manifest.pluginId;
    if (typeof plugin.start === 'function') await plugin.start(contextFor(plugin));
    plugin.state = 'started';
    return plugin.manifest.pluginId;
  }
  async function stop(id) {
    const plugin = get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (plugin.state !== 'started') return plugin.manifest.pluginId;
    if (typeof plugin.stop === 'function') await plugin.stop(contextFor(plugin));
    plugin.state = 'stopped';
    return plugin.manifest.pluginId;
  }
  return {
    add,
    get,
    start,
    stop,
    async remove(id) { const plugin = get(id); if (!plugin) return false; await stop(id); return byId.delete(String(id)); },
    all: () => [...byId.values()],
    list: ({ state } = {}) => [...byId.values()].filter(plugin => !state || plugin.state === state).map(plugin => ({ ...plugin.manifest, state: plugin.state })),
    manifest: id => { const plugin = get(id); return plugin ? { ...plugin.manifest, state: plugin.state } : null; },
  };
}
