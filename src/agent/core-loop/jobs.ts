import { randomUUID } from 'node:crypto';

/**
 * Background jobs (agent-v2-design.md §2, P3).
 *
 * Generation must not own the turn. A long-running tool (image generation)
 * registers a Job here and the tool call returns immediately with the job id;
 * the conversation keeps flowing. When a job settles, listeners are notified so
 * the loop can synthesize a task_notification into the thread — waking an idle
 * agent to speak about the result, or waiting for the turn boundary when busy.
 *
 * Deliberately dependency-free and event-emitter-free: plain callbacks, plain
 * state. `snapshot()` feeds the system prompt's "running tasks" section, so the
 * model always knows what is in flight.
 */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  /** Tool name that started the job, e.g. "generate_image". */
  tool: string;
  /** Short human/model-readable description of what the job does. */
  summary: string;
  status: JobStatus;
  /** 0..1 when the runner reports progress. */
  progress: number | null;
  artifactIds: string[];
  error?: string;
  startedAt: string;
  settledAt?: string;
}

export interface JobStartInput {
  tool: string;
  summary: string;
  /** The async work. Resolve with artifact ids produced, if any. */
  run: (report: (progress: number, note?: string) => void, signal: AbortSignal) => Promise<string[]>;
}

export interface JobSettledEvent {
  job: Job;
  /** Synthetic result summary for the thread's task_notification. */
  outcome:
    | { status: 'done'; artifactIds: string[] }
    | { status: 'failed'; error: string }
    | { status: 'cancelled' };
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly settledListeners: Array<(event: JobSettledEvent) => void> = [];
  /** Bounded settled-job memory: history the model may still need, oldest evicted. */
  private readonly settledOrder: string[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 20) {
    this.maxHistory = maxHistory;
  }

  onSettled(listener: (event: JobSettledEvent) => void): void {
    this.settledListeners.push(listener);
  }

  /**
   * Launch a job. The returned id goes into the thread immediately; the promise
   * resolves with the same id as soon as the job is *registered* (running), not
   * settled — the caller must not await completion inside the turn.
   */
  start(input: JobStartInput): { id: string; running: boolean } {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const job: Job = {
      id,
      tool: input.tool,
      summary: input.summary,
      status: 'running',
      progress: 0,
      artifactIds: [],
      startedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, controller);

    const report = (progress: number, _note?: string): void => {
      const current = this.jobs.get(id);
      if (!current || current.status !== 'running') return;
      current.progress = Math.min(1, Math.max(0, progress));
    };

    // The run promise is deliberately not awaited by the caller: settle() owns
    // the terminal transition and notification.
    void (async () => {
      try {
        const artifactIds = await input.run(report, controller.signal);
        if (controller.signal.aborted) return; // cancel() already settled it
        job.artifactIds = artifactIds ?? [];
        this.settle(id, { status: 'done', artifactIds: job.artifactIds });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.settle(id, { status: 'failed', error: message });
      }
    })();

    return { id, running: true };
  }

  /** Abort a running job. Settles as cancelled; notifications still fire. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'running' && job.status !== 'pending')) return false;
    job.status = 'cancelled';
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.settle(id, { status: 'cancelled' });
    return true;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Everything the system prompt's task section should show. */
  snapshot(): Job[] {
    return [...this.jobs.values()];
  }

  activeCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.status === 'pending') count += 1;
    }
    return count;
  }

  private settle(id: string, outcome: JobSettledEvent['outcome']): void {
    const job = this.jobs.get(id);
    if (!job || job.settledAt) return; // idempotent: first terminal state wins
    job.status = outcome.status;
    job.settledAt = new Date().toISOString();
    if (outcome.status === 'failed') job.error = outcome.error;
    if (outcome.status === 'cancelled') job.progress = null;
    this.controllers.delete(id);

    // Bound history: the record stays queryable for the model, but a long
    // session must not accumulate unbounded job entries (design §8 log caps).
    this.settledOrder.push(id);
    while (this.settledOrder.length > this.maxHistory) {
      const oldest = this.settledOrder.shift();
      if (oldest !== undefined) this.jobs.delete(oldest);
    }

    const event: JobSettledEvent = { job: { ...job }, outcome };
    for (const listener of this.settledListeners) {
      try {
        listener(event);
      } catch {
        // A broken observer must never take a job down.
      }
    }
  }
}
