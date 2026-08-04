export const TRACE_SCHEMA_VERSION = 1;

export function traceError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateTaskTrace(trace, taskId, projectId) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw traceError('trace_invalid', 'Trace must be an object');
  }
  const schemaVersion = trace.schemaVersion ?? 0;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > TRACE_SCHEMA_VERSION) {
    throw traceError('trace_schema_unsupported', `Unsupported trace schema version: ${schemaVersion}`);
  }
  if (trace.taskId !== taskId) {
    throw traceError('trace_invalid', 'Trace task owner does not match the requested task');
  }
  if (trace.projectId !== projectId) {
    throw traceError('trace_invalid', 'Trace project owner does not match the task owner');
  }
  return trace;
}
