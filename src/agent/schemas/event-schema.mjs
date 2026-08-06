const EventTypes = [
  'agent:status',
  'agent:step',
  'agent:tool-call',
  'agent:tool-result',
  'agent:message',
  'agent:error',
  'agent:plan',
  'agent:task',
  'agent:trace',
  'agent:progress',
  'agent:feedback',
  'agent:context-usage',
];

const BaseEventSchema = {
  type: 'object',
  required: ['type', 'timestamp'],
  properties: {
    type: { type: 'string', enum: EventTypes },
    timestamp: { type: 'number', description: 'Unix timestamp in milliseconds' },
    agentId: { type: 'string', description: 'Agent instance identifier' },
    projectId: { type: 'string', description: 'Project identifier for grouping' },
    sessionId: { type: 'string', description: 'Session identifier for grouping' },
    traceId: { type: 'string', description: 'Trace identifier for debugging' },
    taskId: { type: 'string', description: 'Task identifier for multi-step tracking' },
  },
};

const StatusEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    status: { type: 'string', enum: ['idle', 'classifying', 'clarifying', 'planning', 'awaiting_confirmation', 'executing', 'observing', 'retrying', 'replanning', 'completed', 'failed', 'cancelled', 'running', 'error'] },
    uiStatus: { type: 'string', enum: ['idle', 'running', 'completed', 'error', 'cancelled'] },
    message: { type: 'string', maxLength: 200 },
    progress: { type: 'number', minimum: 0, maximum: 100 },
  },
};

const StepEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    stepId: { type: 'string' },
    tool: { type: 'string' },
    skill: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'error', 'skipped'] },
    description: { type: 'string' },
    duration_ms: { type: 'number' },
    error: { type: 'string' },
  },
};

const ToolCallEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    tool: { type: 'string' },
    input: { type: 'object' },
    stepId: { type: 'string' },
  },
};

const ToolResultEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    tool: { type: 'string' },
    result: { type: 'object' },
    stepId: { type: 'string' },
    success: { type: 'boolean' },
    duration_ms: { type: 'number' },
  },
};

const MessageEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    role: { type: 'string', enum: ['user', 'agent', 'system'] },
    content: { type: 'string' },
    images: { type: 'array', items: { type: 'object' } },
    messageId: { type: 'string' },
    streaming: { type: 'boolean' },
    done: { type: 'boolean' },
  },
};

const ErrorEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    message: { type: 'string' },
    code: { type: 'string' },
    stepId: { type: 'string' },
    stack: { type: 'string' },
  },
};

const PlanEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    stage: { type: 'string', enum: ['planning', 'complete', 'error'] },
    plan: { type: 'object' },
    steps: { type: 'array' },
    message: { type: 'string' },
  },
};

const ProgressEventSchema = {
  ...BaseEventSchema,
  properties: {
    ...BaseEventSchema.properties,
    scope: { type: 'string', enum: ['agent', 'generation'] },
    stage: { type: 'string' },
    percent: { type: 'number', minimum: 0, maximum: 100 },
    message: { type: 'string', maxLength: 200 },
    stepId: { type: 'string' },
    nodeId: { type: 'string' },
    nodeType: { type: 'string' },
    value: { type: 'number' },
    max: { type: 'number' },
  },
};

function createEvent(type, data = {}) {
  return {
    type,
    timestamp: Date.now(),
    agentId: data.agentId || 'default',
    projectId: data.projectId || '',
    sessionId: data.sessionId || '',
    traceId: data.traceId || '',
    taskId: data.taskId || '',
    ...data,
  };
}

const EventSchemas = {
  StatusEventSchema,
  StepEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  MessageEventSchema,
  ErrorEventSchema,
  PlanEventSchema,
  ProgressEventSchema,
};

export {
  EventTypes,
  BaseEventSchema,
  StatusEventSchema,
  StepEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  MessageEventSchema,
  ErrorEventSchema,
  PlanEventSchema,
  ProgressEventSchema,
  EventSchemas,
  createEvent,
};
