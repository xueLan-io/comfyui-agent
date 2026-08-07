import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAuditEvent } from './audit-events.mjs';
export class AuditSink {
  constructor({ directory, clock = () => Date.now(), flushSecurityEvents = true } = {}) { this.directory = directory; this.clock = clock; this.flushSecurityEvents = flushSecurityEvents; this.sequence = 0; this.queue = Promise.resolve(); }
  emit(input = {}) {
    const event = createAuditEvent({ ...input, sequence: ++this.sequence, timestamp: input.timestamp ?? this.clock() });
    if (!this.directory) return Promise.resolve(event);
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    const file = join(this.directory, `audit-${date}.jsonl`);
    this.queue = this.queue.catch(() => {}).then(async () => { await mkdir(dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8'); });
    return this.queue.then(() => event);
  }
}
