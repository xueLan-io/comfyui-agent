import { assertAuthorized } from './authorization.mjs';
import { assertDeadline } from './deadline.mjs';
export class AdmissionController {
  constructor({ policyEngine, rateLimiter, quotaManager, limits = {}, limitResolver, clock = () => Date.now() } = {}) { this.policyEngine = policyEngine; this.rateLimiter = rateLimiter; this.quotaManager = quotaManager; this.limits = limits; this.limitResolver = limitResolver; this.clock = clock; this.active = new Map(); }
  resolveLimit(key, context) {
    if (typeof this.limitResolver === 'function') return this.limitResolver(key, context);
    if (this.limits[key] !== undefined) return this.limits[key];
    const template = Object.keys(this.limits).find(candidate => candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1)));
    if (template) return this.limits[template];
    const prefix = Object.keys(this.limits).find(candidate => candidate.endsWith(':') && key.startsWith(candidate));
    return prefix ? this.limits[prefix] : undefined;
  }
  admit(context, { action, resource = {}, input = {}, quota = {}, operation = action } = {}) { const decision = this.policyEngine.authorize(context, action, resource, input); assertAuthorized(decision); const rate = this.rateLimiter?.checkRateLimit(context, operation); if (rate && !rate.allowed) throw Object.assign(new Error('Rate limit exceeded'), { code: 'RATE_LIMITED', retryAfterMs: rate.retryAfterMs, rate }); let reservation; try { reservation = this.quotaManager?.reserveQuota(context, quota); const keys = [`session:${context.sessionId}`, `project:${context.projectId}`, `principal:${context.principalId}`]; for (const key of keys) { const max = this.resolveLimit(key, context); if (max !== undefined && (this.active.get(key) || 0) >= max) throw Object.assign(new Error('Execution capacity exceeded'), { code: 'RATE_LIMITED', retryAfterMs: 1000 }); } assertDeadline(context.deadline, this.clock); for (const key of keys) this.active.set(key, (this.active.get(key) || 0) + 1); let released = false; return { decision, reservation, release: (actual, commit = false) => { if (released) return; released = true; for (const key of keys) this.active.set(key, Math.max(0, (this.active.get(key) || 1) - 1)); if (reservation) commit ? this.quotaManager.commitQuota(reservation, actual) : this.quotaManager.releaseQuota(reservation); } }; } catch (error) { if (reservation) this.quotaManager.releaseQuota(reservation); throw error; } }
}
