// MCP settings IPC domain extracted from electron/main.mjs (2026-08-14):
// embedded MCP service configuration. Depends on the preferences store and
// the restart hook owned by main.mjs.

export function registerMcpIpc(ctx) {
  const { ipcMain, prefStore, mcpModuleFlags, restartEmbeddedMcp } = ctx;

  ipcMain.handle('mcp:settings', async () => {
    const mcp = prefStore.get('mcp') || {};
    return { enabled: mcp.enabled === true, host: mcp.host || '127.0.0.1', port: mcp.port || 3333, hasToken: Boolean(mcp.token), modules: mcpModuleFlags(mcp.modules || {}) };
  });

  ipcMain.handle('mcp:save-settings', async (_, settings = {}) => {
    const current = prefStore.get('mcp') || {};
    const port = Number(settings.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP 端口必须是 1-65535 的整数');
    const host = String(settings.host || '127.0.0.1').trim();
    if (!host || /[\s/]/.test(host)) throw new Error('MCP 主机地址无效');
    const token = settings.token === undefined ? current.token || '' : String(settings.token || '').trim();
    if (settings.enabled === true && host !== '127.0.0.1' && host !== 'localhost' && !token) throw new Error('MCP 监听局域网地址时必须设置访问令牌');
    const modules = settings.modules && typeof settings.modules === 'object'
      ? mcpModuleFlags({ web: settings.modules.web, files: settings.modules.files, comfyui: settings.modules.comfyui, skills: settings.modules.skills })
      : mcpModuleFlags(current.modules || {});
    prefStore.set('mcp', { enabled: settings.enabled === true, host, port, token, modules });
    await restartEmbeddedMcp();
    return { enabled: settings.enabled === true, host, port, hasToken: Boolean(token), modules };
  });
}
