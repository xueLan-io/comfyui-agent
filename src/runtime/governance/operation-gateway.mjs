import { createHash, randomUUID } from 'node:crypto';
import { createGovernanceContext, assertGovernanceContext } from './context.mjs';
import { assertAuthorized } from './authorization.mjs';
import { assertDeadline, deadlineSignal } from './deadline.mjs';

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function errorData(error) {
  return { code: error?.code || 'OPERATION_FAILED', message: error?.message || String(error), retryAfterMs: error?.retryAfterMs || 0 };
}

export function confirmationDigest(input) { return digest(input); }

export function assertConfirmationBinding({ confirmation, expectedDigest, requestId, previewId } = {}) {
  if (!confirmation || confirmation.accepted !== true || confirmation.digest !== expectedDigest || confirmation.requestId !== requestId || (previewId && confirmation.previewId !== previewId)) {
    throw Object.assign(new Error('Confirmation does not match the prepared operation'), { code: 'CONFIRMATION_INVALID' });
  }
  return true;
}

export class OperationGateway {
  constructor({ policyEngine, admission, audit, clock = () => Date.now(), defaultOwner = {} } = {}) {
    this.policyEngine = policyEngine;
    this.admission = admission;
    this.audit = audit;
    this.auditSink = audit;
    this.clock = clock;
    this.defaultOwner = defaultOwner;
  }

  context(input = {}, { source = 'internal', sideEffect = true } = {}) {
    const context = createGovernanceContext({ ...this.defaultOwner, ...input, source, requestId: input.requestId || `request_${randomUUID()}`, taskId: input.taskId || `task_${randomUUID()}`, traceId: input.traceId || `trace_${randomUUID()}` });
    return assertGovernanceContext(context, { sideEffect });
  }

  async run({ context, action, resource = {}, input = {}, quota = {}, operation = action, execute, confirmation } = {}) {
    const governedContext = context || this.context({}, { source: 'internal' });
    const payloadDigest = confirmationDigest({ action, resource, input });
    const decision = this.policyEngine.authorize(governedContext, action, resource, { ...input, confirmation: confirmation ? true : input.confirmation });
    let executing = false;
    let terminalEmitted = false;
    try {
      assertAuthorized(decision);
      if (decision.requiredConfirmation) assertConfirmationBinding({ confirmation, expectedDigest: payloadDigest, requestId: governedContext.requestId, previewId: resource.previewId });
      const lease = this.admission?.admit(governedContext, { action, resource, input: { ...input, confirmation: true }, quota, operation });
      let cancellation;
      try {
        await this.audit?.emit({ ...governedContext, action, decision: 'started', reason: decision.reason, data: { resource, digest: payloadDigest } });
        const deadline = assertDeadline(governedContext.deadline, this.clock);
        cancellation = deadlineSignal(deadline, input.signal, this.clock);
        executing = true;
        const result = await execute({ context: governedContext, signal: cancellation.signal, deadline, decision });
        lease?.release(input.actualQuota, true);
        await this.audit?.emit({ ...governedContext, action, decision: 'allow', reason: 'completed', data: { digest: payloadDigest, result: result?.state || 'completed' } });
        terminalEmitted = true;
        return result;
      } catch (error) {
        lease?.release(undefined, false);
        await this.audit?.emit({ ...governedContext, action, decision: error.code === 'CANCELLED' ? 'cancel' : 'error', reason: error.code || error.message, data: { digest: payloadDigest, error: errorData(error) } });
        terminalEmitted = true;
        throw error;
      } finally { cancellation?.cancel(); }
    } catch (error) {
      if (!executing && !terminalEmitted) await this.audit?.emit({ ...governedContext, action, decision: 'deny', reason: error.code || error.message, data: { digest: payloadDigest, error: errorData(error) } }).catch(() => {});
      throw error;
    }
  }
}
