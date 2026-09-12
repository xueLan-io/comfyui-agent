import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunEvent, RunEventListener } from '../core/events.ts';
import { redact } from './logger.ts';

/**
 * Appends each run event as one JSONL record.
 *
 * Writes are serialised through a promise chain so concurrent listeners cannot
 * interleave partial lines. Failures are swallowed: tracing is diagnostic and
 * must never take down a run.
 */
export class Tracer {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private readonly traceDir: string;
  private readonly runId: string;

  constructor(traceDir: string, runId: string) {
    this.traceDir = traceDir;
    this.runId = runId;
    this.path = join(traceDir, `${runId}.jsonl`);
    this.ready = mkdir(traceDir, { recursive: true }).then(() => undefined);
  }

  get filePath(): string {
    return this.path;
  }

  private write(event: RunEvent): void {
    const record = { ts: new Date().toISOString(), ...(redact(event) as object) };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.path, line, 'utf8'))
      .catch(() => undefined);
  }

  listener(): RunEventListener {
    return (event) => this.write(event);
  }

  /** Resolve once every queued append has settled. Call before process exit. */
  async flush(): Promise<void> {
    await this.queue;
  }
}
