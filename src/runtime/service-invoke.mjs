import { createHash } from 'node:crypto';
import { assertServiceConfirmation, assertServiceOwner, assertServicePermission } from './service-policy.mjs';

function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

export class ServiceInvoker {
  constructor({ registry, ledger, taskManager, clock = () => Date.now() } = {}) { this.registry = registry; this.ledger = ledger; this.taskManager = taskManager; this.clock = clock; this.previews = new Map(); }
  async prepare({ serviceId, input = {}, owner = {} } = {}) {
    const service = this.registry.get(serviceId);
    if (!service) return { code: 'SERVICE_NOT_FOUND', error: `Unknown service: ${serviceId}` };
    assertServicePermission(service.manifest, 'prepare', owner);
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
    assertServiceConfirmation(service.manifest, 'invoke', { ...input, owner: input.owner || {} });
    assertServiceOwner(input.owner || {}, preview.owner);
    if (input.requestId !== preview.requestId || input.serviceId !== preview.serviceId) return { code: 'SERVICE_PREVIEW_MISMATCH', error: 'Preview identity does not match' };
    const result = await service.invoke({ ...preview, idempotencyKey: input.idempotencyKey || preview.digest, owner: input.owner || preview.owner });
    this.ledger?.update(preview.requestId, { state: result?.state || 'queued', taskId: result?.taskId || '' });
    return { ...result, serviceId: preview.serviceId, requestId: preview.requestId, previewId: preview.previewId };
  }
  status({ serviceId, requestId, taskId, owner } = {}) { const service = this.registry.get(serviceId); if (!service) return { code: 'SERVICE_NOT_FOUND' }; assertServicePermission(service.manifest, 'status', owner); if (!requestId && !taskId) throw Object.assign(new Error('requestId or taskId is required'), { code: 'RESOURCE_ID_REQUIRED' }); const entry = requestId ? this.ledger?.snapshot(requestId) : null; if (entry) assertServiceOwner(owner || {}, entry); const task = taskId ? this.taskManager?.get?.(taskId) : null; if (task) assertServiceOwner(owner || {}, task); if (taskId && !requestId && !task) return { code: 'TASK_NOT_FOUND' }; return typeof service.status === 'function' ? service.status({ requestId, taskId, owner }) : entry || task || null; }
  result({ serviceId, requestId, taskId, owner } = {}) { const service = this.registry.get(serviceId); if (!service) return { code: 'SERVICE_NOT_FOUND' }; assertServicePermission(service.manifest, 'result', owner); if (!requestId && !taskId) throw Object.assign(new Error('requestId or taskId is required'), { code: 'RESOURCE_ID_REQUIRED' }); const entry = requestId ? this.ledger?.snapshot(requestId) : null; if (entry) assertServiceOwner(owner || {}, entry); const task = taskId ? this.taskManager?.get?.(taskId) : null; if (task) assertServiceOwner(owner || {}, task); if (taskId && !requestId && !task) return { code: 'TASK_NOT_FOUND' }; return typeof service.result === 'function' ? service.result({ requestId, taskId, owner }) : entry?.result || task?.result || null; }
}
