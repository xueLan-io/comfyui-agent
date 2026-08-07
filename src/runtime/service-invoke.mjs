import { createHash } from 'node:crypto';
import { assertServiceConfirmation, assertServiceOwner } from './service-policy.mjs';

function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

export class ServiceInvoker {
  constructor({ registry, ledger, taskManager, clock = () => Date.now() } = {}) { this.registry = registry; this.ledger = ledger; this.taskManager = taskManager; this.clock = clock; this.previews = new Map(); }
  async prepare({ serviceId, input = {}, owner = {} } = {}) {
    const service = this.registry.get(serviceId);
    if (!service) return { code: 'SERVICE_NOT_FOUND', error: `Unknown service: ${serviceId}` };
    const normalized = typeof service.normalizeInput === 'function' ? await service.normalizeInput(input) : structuredClone(input);
    const previewId = `service_preview_${this.clock()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestId = input.requestId || `request_${this.clock()}_${Math.random().toString(36).slice(2, 8)}`;
    const preview = { previewId, requestId, serviceId, owner: structuredClone(owner), normalizedInput: normalized, digest: digest(normalized), serviceVersion: service.manifest.version, expiresAt: this.clock() + 15 * 60 * 1000, confirmation: { required: service.manifest.execution.requiresConfirmation !== false, actions: ['service_invoke'] } };
    this.previews.set(previewId, preview);
    this.ledger?.begin(requestId, { source: owner.source || 'service', fingerprint: preview.digest, previewId, serviceId, ...owner });
    return preview;
  }
  async invoke(input = {}) {
    const preview = this.previews.get(input.previewId);
    if (!preview) return { code: 'PREVIEW_NOT_FOUND', error: 'Service preview not found or expired' };
    if (preview.expiresAt < this.clock()) return { code: 'PREVIEW_EXPIRED', error: 'Service preview has expired' };
    const service = this.registry.get(preview.serviceId);
    assertServiceOwner(input.owner || preview.owner, preview.owner);
    assertServiceConfirmation(service.manifest, 'invoke', input);
    if (input.requestId !== preview.requestId || input.serviceId !== preview.serviceId) return { code: 'SERVICE_PREVIEW_MISMATCH', error: 'Preview identity does not match' };
    const result = await service.invoke({ ...preview, idempotencyKey: input.idempotencyKey || preview.digest, owner: input.owner || preview.owner });
    this.ledger?.update(preview.requestId, { state: result?.state || 'queued', taskId: result?.taskId || '' });
    return { ...result, serviceId: preview.serviceId, requestId: preview.requestId, previewId: preview.previewId };
  }
  status({ serviceId, requestId, taskId } = {}) { const service = this.registry.get(serviceId); if (!service) return { code: 'SERVICE_NOT_FOUND' }; return typeof service.status === 'function' ? service.status({ requestId, taskId }) : this.ledger?.snapshot(requestId) || null; }
  result({ serviceId, requestId, taskId } = {}) { const service = this.registry.get(serviceId); if (!service) return { code: 'SERVICE_NOT_FOUND' }; return typeof service.result === 'function' ? service.result({ requestId, taskId }) : this.ledger?.snapshot(requestId)?.result || null; }
}
