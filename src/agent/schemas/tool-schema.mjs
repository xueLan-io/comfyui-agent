const ToolInputSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'JSON Schema type' },
    properties: { type: 'object', description: 'Input property definitions' },
    required: { type: 'array', items: { type: 'string' }, description: 'Required input fields' },
  },
};

const ToolDefinitionSchema = {
  type: 'object',
  required: ['name', 'description', 'input_schema', 'output_schema', 'side_effects', 'requires_confirmation', 'idempotent', 'retry'],
  properties: {
    name: { type: 'string', pattern: '^[a-z_][a-z0-9_]*$', description: 'Unique tool identifier' },
    description: { type: 'string', maxLength: 200, description: 'What the tool does' },
    input_schema: { type: 'object', description: 'JSON Schema for tool inputs' },
    output_schema: { type: 'object', description: 'JSON Schema for tool outputs' },
    side_effects: { type: 'array', items: { type: 'string' }, description: 'Observable state changes caused by the tool' },
    requires_confirmation: { type: 'boolean', description: 'Whether execution requires explicit user confirmation' },
    idempotent: { type: 'boolean', description: 'Whether repeating the same call has the same external effect' },
    retry: {
      type: 'object',
      description: 'Automatic retry contract',
      properties: {
        mode: { type: 'string', enum: ['never', 'limited'] },
        max_attempts: { type: 'number' },
      },
    },
    version: { type: 'string', description: 'Tool version' },
    category: {
      type: 'string',
      enum: ['generation', 'enhancement', 'filesystem', 'management', 'web'],
      description: 'Tool category for routing',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Search/filter tags' },
    timeout_ms: { type: 'number', description: 'Default timeout in milliseconds' },
  },
};

function validateToolDefinition(tool) {
  const errors = [];

  if (!tool || typeof tool !== 'object') return { valid: false, errors: ['Tool must be an object'] };
  if (!tool.name) errors.push('Tool must have a "name"');
  if (!tool.description) errors.push('Tool must have a "description"');
  if (!tool.input_schema) errors.push('Tool must have an "input_schema"');
  if (!tool.output_schema) errors.push('Tool must have an "output_schema"');
  if (!Array.isArray(tool.side_effects)) errors.push('Tool must have "side_effects"');
  if (typeof tool.requires_confirmation !== 'boolean') errors.push('Tool must have "requires_confirmation"');
  if (typeof tool.idempotent !== 'boolean') errors.push('Tool must have "idempotent"');
  if (!tool.retry || !['never', 'limited'].includes(tool.retry.mode)) errors.push('Tool must have a valid "retry" contract');
  if (typeof tool.execute !== 'function') errors.push('Tool must have an "execute" function');

  return { valid: errors.length === 0, errors };
}

function toolContract(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    output_schema: tool.output_schema,
    side_effects: [...(tool.side_effects || [])],
    requires_confirmation: tool.requires_confirmation === true,
    idempotent: tool.idempotent === true,
    retry: {
      mode: tool.retry?.mode || 'never',
      ...(tool.retry?.max_attempts ? { max_attempts: tool.retry.max_attempts } : {}),
    },
  };
}

function plannerToolContracts(tools = {}) {
  return Object.values(tools).map(toolContract);
}

function validateToolInput(tool, input) {
  if (!tool.input_schema) return { valid: true, errors: [] };

  const schema = tool.input_schema;
  const errors = [];

  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (input[field] === undefined || input[field] === null) {
        errors.push(`Missing required input: "${field}"`);
      }
    }
  }

  for (const [field, value] of Object.entries(input || {})) {
    const definition = schema.properties?.[field];
    if (!definition || value === undefined || value === null) continue;

    const expectedType = definition.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (expectedType && actualType !== expectedType) {
      errors.push(`Invalid type for "${field}": expected ${expectedType}`);
      continue;
    }
    if (definition.enum && !definition.enum.includes(value)) {
      errors.push(`Invalid value for "${field}"`);
    }
    if (typeof value === 'number') {
      if (definition.minimum !== undefined && value < definition.minimum) errors.push(`"${field}" is below minimum`);
      if (definition.maximum !== undefined && value > definition.maximum) errors.push(`"${field}" exceeds maximum`);
    }
    if (Array.isArray(value) && definition.items?.type) {
      const invalidItem = value.some(item => typeof item !== definition.items.type);
      if (invalidItem) errors.push(`Invalid item type in "${field}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export { ToolDefinitionSchema, ToolInputSchema, validateToolDefinition, validateToolInput, toolContract, plannerToolContracts };
