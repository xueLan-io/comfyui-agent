export class RateLimiter {
  constructor({ limit = 120, intervalMs = 60_000, burst = limit, clock = () => Date.now() } = {}) { this.limit = limit; this.intervalMs = intervalMs; this.burst = burst; this.clock = clock; this.buckets = new Map(); }
  checkRateLimit(context, operation = 'request') {
    const now = this.clock(); const key = `${context?.principalId || 'anonymous'}:${context?.sessionId || ''}:${context?.projectId || ''}:${operation}`; let bucket = this.buckets.get(key);
    if (!bucket) bucket = { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) * this.limit) / this.intervalMs); bucket.at = now;
    const allowed = bucket.tokens >= 1; if (allowed) bucket.tokens -= 1; this.buckets.set(key, bucket);
    return { allowed, retryAfterMs: allowed ? 0 : Math.ceil((1 - bucket.tokens) * this.intervalMs / this.limit), limit: this.limit, remaining: Math.floor(bucket.tokens) };
  }
}
