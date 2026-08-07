export function createFakeIpc() {
  const handlers = new Map();
  const events = [];
  return {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      handlers.set(channel, handler);
    },
    async invoke(channel, payload, sender = {}) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler({ sender }, payload);
    },
    send(channel, payload) { events.push({ channel, payload }); },
    handler: channel => handlers.get(channel) || null,
    channels: () => [...handlers.keys()],
    events: () => structuredClone(events),
  };
}
