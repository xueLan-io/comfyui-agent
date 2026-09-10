export type ToolRetryMode = 'never' | 'limited';

export interface ToolRetryContract {
  mode: ToolRetryMode;
  max_attempts?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema?: Record<string, any>;
  output_schema?: Record<string, any>;
  side_effects?: string[];
  requires_confirmation?: boolean;
  idempotent?: boolean;
  retry?: ToolRetryContract;
  version?: string;
  category?: string;
  risk_level?: string;
  permission?: string;
  scope?: string;
  supports_preview?: boolean;
  supports_rollback?: boolean;
  output_types?: string[];
  surfaces?: string[];
  tags?: string[];
  timeout_ms?: number;
  execute?: (input: Record<string, any>, context?: any) => any;
  [key: string]: unknown;
}

export interface ToolContract {
  name: string;
  description: string;
  input_schema?: Record<string, any>;
  output_schema?: Record<string, any>;
  side_effects: string[];
  requires_confirmation: boolean;
  idempotent: boolean;
  retry: ToolRetryContract;
  version?: string;
  category?: string;
  tags?: string[];
  timeout_ms?: number;
  risk_level?: string;
  permission?: string;
  scope?: string;
  supports_preview?: boolean;
  supports_rollback?: boolean;
  output_types?: string[];
  surfaces?: string[];
  [key: string]: unknown;
}

export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
}

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
      enum: ['generation', 'enhancement', 'filesystem', 'management', 'web', 'workflow', 'runtime', 'queue', 'model', 'media', 'service'],
      description: 'Tool category for routing',
    },
    risk_level: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'admin'], description: 'Operational risk level' },
    permission: { type: 'string', enum: ['read', 'execute', 'mutate', 'admin'], description: 'Required permission' },
    scope: { type: 'string', enum: ['session', 'project', 'workflow', 'runtime'], description: 'State scope' },
    supports_preview: { type: 'boolean', description: 'Whether the tool can return a preview' },
    supports_rollback: { type: 'boolean', description: 'Whether the tool supports rollback' },
    output_types: { type: 'array', items: { type: 'string' }, description: 'Planner output types produced by the tool' },
    surfaces: { type: 'array', items: { type: 'string' }, description: 'Calling surfaces that may expose the tool' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Search/filter tags' },
    timeout_ms: { type: 'number', description: 'Default timeout in milliseconds' },
  },
};

export function validateToolDefinition(tool: unknown): ToolValidationResult {
  const errors: string[] = [];

  if (!tool || typeof tool !== 'object') return { valid: false, errors: ['Tool must be an object'] };
  const t = tool as Record<string, any>;
  if (!t.name) errors.push('Tool must have a "name"');
  if (!t.description) errors.push('Tool must have a "description"');
  if (!t.input_schema) errors.push('Tool must have an "input_schema"');
  if (!t.output_schema) errors.push('Tool must have an "output_schema"');
  if (!Array.isArray(t.side_effects)) errors.push('Tool must have "side_effects"');
  if (typeof t.requires_confirmation !== 'boolean') errors.push('Tool must have "requires_confirmation"');
  if (typeof t.idempotent !== 'boolean') errors.push('Tool must have "idempotent"');
  if (!t.retry || !['never', 'limited'].includes(t.retry.mode)) errors.push('Tool must have a valid "retry" contract');
  if (typeof t.execute !== 'function') errors.push('Tool must have an "execute" function');
  if (t.risk_level !== undefined && !['none', 'low', 'medium', 'high', 'admin'].includes(t.risk_level)) errors.push('Tool must have a valid "risk_level"');
  if (t.permission !== undefined && !['read', 'execute', 'mutate', 'admin'].includes(t.permission)) errors.push('Tool must have a valid "permission"');
  if (t.output_types !== undefined && (!Array.isArray(t.output_types) || t.output_types.some(type => typeof type !== 'string'))) errors.push('Tool must have valid "output_types"');

  return { valid: errors.length === 0, errors };
}

export function toolContract(tool: ToolDefinition): ToolContract {
  const contract: ToolContract = {
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
  for (const field of ['version', 'category', 'tags', 'timeout_ms', 'risk_level', 'permission', 'scope', 'supports_preview', 'supports_rollback', 'output_types', 'surfaces']) {
    const value = tool[field];
    if (value !== undefined) contract[field] = Array.isArray(value) ? [...value] : value;
  }
  return contract;
}

export function plannerToolContracts(tools: Record<string, ToolDefinition> = {}): ToolContract[] {
  return Object.values(tools).map(toolContract);
}

// Fields the executor injects into tool inputs after planning (trusted runtime
// context). They are not part of the LLM-visible schema but must not fail
// additionalProperties checks on the enriched input. The executor overwrites
// their values from trusted context before dispatch.
const RUNTIME_INJECTED_FIELDS = new Set(['workflowDir', 'allowedRoots', 'comfyRoot', 'signal', 'llmProvider', 'sandboxInput']);

// Default hard bounds applied when a schema does not declare its own. Blocks
// LLM-supplied megabyte-scale payloads from materializing in the agent.
const DEFAULT_MAX_STRING_LENGTH = 2 * 1024 * 1024;
const DEFAULT_MAX_ARRAY_ITEMS = 50000;

export function validateToolInput(tool: ToolDefinition, input: unknown): ToolValidationResult {
  if (!tool.input_schema) return { valid: true, errors: [] };

  const schema = tool.input_schema;
  const errors: string[] = [];

  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if ((input as Record<string, any>)?.[field] === undefined || (input as Record<string, any>)?.[field] === null) {
        errors.push(`Missing required input: "${field}"`);
      }
    }
  }

  for (const [field, value] of Object.entries((input || {}) as Record<string, any>)) {
    const definition = schema.properties?.[field];
    if (!definition) {
      if (schema.additionalProperties === false && !RUNTIME_INJECTED_FIELDS.has(field)) errors.push(`Unknown input: "${field}"`);
      continue;
    }
    if (value === undefined || value === null) continue;

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
    if (typeof value === 'string') {
      const maxLength = definition.maxLength ?? DEFAULT_MAX_STRING_LENGTH;
      if (value.length > maxLength) errors.push(`"${field}" exceeds max length (${maxLength})`);
    }
    if (Array.isArray(value)) {
      if (definition.items?.type) {
        const invalidItem = value.some(item => typeof item !== definition.items.type);
        if (invalidItem) errors.push(`Invalid item type in "${field}"`);
      }
      const maxItems = definition.maxItems ?? DEFAULT_MAX_ARRAY_ITEMS;
      if (value.length > maxItems) errors.push(`"${field}" exceeds max items (${maxItems})`);
    }
    if (expectedType === 'object' && value && !Array.isArray(value) && definition.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!definition.properties?.[key]) errors.push(`Unknown input: "${field}.${key}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export { ToolDefinitionSchema, ToolInputSchema };
