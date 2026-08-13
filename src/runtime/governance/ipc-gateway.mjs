export function createIpcGateway({ gateway, resolveContext, resolveResource = () => ({}), handlers = new Map(), senderCheck = () => false } = {}) {
  return {
    registerAuthorizedHandler(channel, definition, handler) {
      handlers.set(channel, async (event, input = {}) => {
        if (!senderCheck(event, definition)) throw Object.assign(new Error('IPC sender is not registered'), { code: 'AUTHORIZATION_DENIED' });
        const context = await resolveContext(event, input, definition);
        const resource = await resolveResource(event, input, definition);
        return gateway.run({ context, action: definition.action, resource, input, confirmation: input.confirmation, quota: definition.quota, operation: channel, execute: execution => handler(event, input, execution) });
      });
      return channel;
    },
    get(channel) { return handlers.get(channel); },
  };
}
