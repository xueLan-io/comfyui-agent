export function createWindowRegistry() {
  const windows = new Map();
  function register(id, webContents, metadata = {}) {
    if (!id || !webContents) throw new Error('window id and webContents are required');
    unregister(id);
    const value = { id: String(id), webContents, metadata: structuredClone(metadata), registeredAt: Date.now() };
    windows.set(value.id, value);
    const cleanup = () => unregister(value.id, webContents);
    webContents.once?.('destroyed', cleanup);
    return value;
  }
  function unregister(id, expected) { const value = windows.get(String(id)); if (!value || (expected && value.webContents !== expected)) return false; windows.delete(String(id)); return true; }
  return {
    register, unregister, get: id => windows.get(String(id)) || null,
    list: () => [...windows.values()].map(({ webContents, ...value }) => value),
    send(channel, data, predicate = () => true) { let sent = 0; for (const value of windows.values()) if (predicate(value.metadata, value.id) && !value.webContents.isDestroyed?.()) { value.webContents.send(channel, data); sent += 1; } return sent; },
    clear() { windows.clear(); },
  };
}
