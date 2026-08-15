// Agent-adjacent IPC domains extracted from electron/main.mjs (2026-08-14):
// memory (long-term project memory) and plugins (host lifecycle). Both are
// thin bridges over the Agent worker RPC surface and share the same ctx
// dependencies: ipcMain + the agent accessor + agent-start helpers.

export function registerAgentExtrasIpc(ctx) {
  const { ipcMain, getAgent, startAgent, getStoredConfig } = ctx;

  ipcMain.handle('memory:get-state', async (_, { projectId = '' } = {}) => { await startAgent(getStoredConfig()); return getAgent().call('memory.getState', [projectId]); });
  ipcMain.handle('memory:set-profile', async (_, { projectId = '', patch = {} } = {}) => { await startAgent(getStoredConfig()); return getAgent().call('memory.setProfile', [projectId, patch]); });
  ipcMain.handle('memory:clear', async (_, { projectId = '' } = {}) => { await startAgent(getStoredConfig()); return getAgent().call('memory.clear', [projectId]); });
  ipcMain.handle('memory:export', async () => { await startAgent(getStoredConfig()); return getAgent().call('memory.export'); });
  ipcMain.handle('memory:recall', async (_, { projectId = '', query = '', limit } = {}) => { await startAgent(getStoredConfig()); return getAgent().call('memory.recall', [projectId, { query, limit }]); });

  ipcMain.handle('plugins:list', async () => {
    await startAgent(getStoredConfig());
    return getAgent().call('plugins.list');
  });
  ipcMain.handle('plugins:enable', async (_, { pluginId = '', enabled = true } = {}) => {
    await startAgent(getStoredConfig());
    return getAgent().call('plugins.enable', [pluginId, Boolean(enabled)]);
  });
  ipcMain.handle('plugins:remove', async (_, { pluginId = '' } = {}) => {
    await startAgent(getStoredConfig());
    return getAgent().call('plugins.remove', [pluginId]);
  });
}
