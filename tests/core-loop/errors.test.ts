import { describe, expect, it } from 'vitest';

import {
  ComfyError,
  compactExecutionError,
  compactPromptRejection,
  toCompactError,
} from '../../src/agent/core-loop/comfy/errors.js';

describe('compactExecutionError', () => {
  it('keeps the exception message, node identity, and a hint', () => {
    const compact = compactExecutionError({
      node_id: '5',
      node_type: 'KSampler',
      exception_type: 'ValueError',
      exception_message: 'cfg must be a float >= 0.0',
      traceback: ['Traceback (most recent call last):', '  File "nodes.py", line 1', 'ValueError: boom'],
    });
    expect(compact.code).toBe('EXECUTION_ERROR');
    expect(compact.message).toContain('cfg must be a float');
    expect(compact.node).toBe('5');
    expect(compact.detail).toContain('KSampler');
    expect(compact.recoverable).toBe(true);
    expect(compact.hint).toContain('KSampler');
  });

  it('falls back to the last traceback line when there is no message', () => {
    const compact = compactExecutionError({ traceback: ['a', 'b', 'RuntimeError: the real reason'] });
    expect(compact.message).toContain('the real reason');
  });
});

describe('compactPromptRejection', () => {
  it('extracts node_errors into a compact detail', () => {
    const compact = compactPromptRejection({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
      node_errors: {
        '4': { errors: [{ message: 'Required input is missing', details: 'positive' }] },
      },
    });
    expect(compact.code).toBe('PROMPT_REJECTED');
    expect(compact.node).toBe('4');
    expect(compact.detail).toContain('Required input is missing');
    expect(compact.hint).toContain('submit_workflow');
  });
});

describe('toCompactError', () => {
  it('passes ComfyError through with its code', () => {
    const compact = toCompactError(new ComfyError('COMFY_UNREACHABLE', 'no server', true, undefined, 'start it'));
    expect(compact.code).toBe('COMFY_UNREACHABLE');
    expect(compact.detail).toBe('start it');
  });

  it('wraps plain errors', () => {
    const compact = toCompactError(new Error('socket hung up'), 'WS');
    expect(compact.code).toBe('WS');
    expect(compact.message).toContain('socket');
  });

  it('stringifies non-Error throwables', () => {
    expect(toCompactError(42).message).toContain('42');
  });
});
