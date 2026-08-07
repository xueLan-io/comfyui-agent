function tool(name, description, input_schema, output_schema, execute, options = {}) {
  return { name, description, input_schema, output_schema, execute, side_effects: options.side_effects || [], requires_confirmation: options.requires_confirmation === true, idempotent: options.idempotent !== false, retry: options.retry || { mode: 'never' }, category: 'service', permission: options.permission || (options.requires_confirmation ? 'execute' : 'read'), risk_level: options.risk_level || (options.requires_confirmation ? 'high' : 'none'), output_types: options.output_types || ['service'] };
}

export function createServiceTools({ registry, invoker } = {}) {
  return [
    tool('service_list', 'List available semantic services.', { type: 'object', properties: { kind: { type: 'string' }, permission: { type: 'string' } }, additionalProperties: false }, { type: 'object', properties: { services: { type: 'array' } } }, input => ({ services: registry?.list(input) || [] })),
    tool('service_manifest', 'Read one semantic service manifest.', { type: 'object', properties: { serviceId: { type: 'string' } }, required: ['serviceId'], additionalProperties: false }, { type: 'object' }, input => registry?.manifest(input.serviceId) || { code: 'SERVICE_NOT_FOUND' }),
    tool('service_prepare', 'Prepare a service invocation without side effects.', { type: 'object', properties: { serviceId: { type: 'string' }, input: { type: 'object' }, owner: { type: 'object' } }, required: ['serviceId'], additionalProperties: false }, { type: 'object' }, input => invoker.prepare(input)),
    tool('service_invoke', 'Invoke a prepared service after explicit confirmation.', { type: 'object', properties: { serviceId: { type: 'string' }, previewId: { type: 'string' }, requestId: { type: 'string' }, confirmation: { type: 'boolean' }, idempotencyKey: { type: 'string' }, owner: { type: 'object' } }, required: ['serviceId', 'previewId', 'requestId', 'confirmation'], additionalProperties: false }, { type: 'object' }, input => invoker.invoke(input), { requires_confirmation: true, idempotent: false, side_effects: ['service_invoke'], permission: 'execute', risk_level: 'high', retry: { mode: 'never' } }),
    tool('service_status', 'Read a service request status.', { type: 'object', properties: { serviceId: { type: 'string' }, requestId: { type: 'string' }, taskId: { type: 'string' } }, required: ['serviceId'], additionalProperties: false }, { type: 'object' }, input => invoker.status(input)),
    tool('service_result', 'Read a service result and media references.', { type: 'object', properties: { serviceId: { type: 'string' }, requestId: { type: 'string' }, taskId: { type: 'string' } }, required: ['serviceId'], additionalProperties: false }, { type: 'object' }, input => invoker.result(input)),
  ];
}
