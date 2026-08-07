export function createFakeWorker({ handlers = {} } = {}) {
  const messages = [];
  const calls = [];
  let connected = true;
  return {
    connected: true,
    pid: 1,
    send(message, callback) {
      if (!connected) {
        callback?.(Object.assign(new Error('Worker disconnected'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
        return;
      }
      messages.push(structuredClone(message));
      if (message.type !== 'call') {
        callback?.();
        return;
      }
      calls.push({ method: message.method, args: structuredClone(message.args || []) });
      Promise.resolve(handlers[message.method]?.(...(message.args || [])))
        .then(result => this.onmessage?.({ type: 'response', id: message.id, ok: true, result }))
        .catch(error => this.onmessage?.({ type: 'response', id: message.id, ok: false, error: error.message, code: error.code }));
      callback?.();
    },
    disconnect() { connected = false; this.connected = false; },
    kill() { connected = false; this.connected = false; },
    emit(message) { this.onmessage?.(message); },
    calls: () => structuredClone(calls),
    messages: () => structuredClone(messages),
  };
}
