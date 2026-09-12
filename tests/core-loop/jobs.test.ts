import { describe, expect, it } from 'vitest';

import { JobManager } from '../../src/agent/core-loop/jobs.js';
import type { JobSettledEvent } from '../../src/agent/core-loop/jobs.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('JobManager', () => {
  it('returns the job id immediately while work runs in the background', async () => {
    const manager = new JobManager();
    const gate = deferred<string[]>();
    const started = manager.start({
      tool: 'generate_image',
      summary: '生成一只狐狸',
      run: () => gate.promise,
    });
    expect(started.running).toBe(true);
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot()[0]?.status).toBe('running');

    gate.resolve(['artifact_1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.get(started.id)?.status).toBe('done');
    expect(manager.get(started.id)?.artifactIds).toEqual(['artifact_1']);
    expect(manager.activeCount()).toBe(0);
  });

  it('notifies listeners with a synthetic outcome on done and failure', async () => {
    const manager = new JobManager();
    const events: JobSettledEvent[] = [];
    manager.onSettled((event) => events.push(event));

    const ok = manager.start({ tool: 't', summary: 's', run: async () => ['a1'] });
    const bad = manager.start({
      tool: 't',
      summary: 's',
      run: async () => {
        throw new Error('OOM on KSampler');
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(2);
    expect(events[0]?.job.id).toBe(ok.id);
    expect(events[0]?.outcome).toEqual({ status: 'done', artifactIds: ['a1'] });
    expect(events[1]?.job.id).toBe(bad.id);
    expect(events[1]?.outcome).toEqual({ status: 'failed', error: 'OOM on KSampler' });
    expect(manager.get(bad.id)?.error).toBe('OOM on KSampler');
  });

  it('cancel aborts the runner signal and settles exactly once', async () => {
    const manager = new JobManager();
    const events: JobSettledEvent[] = [];
    manager.onSettled((event) => events.push(event));

    let sawAbort = false;
    const job = manager.start({
      tool: 'generate_image',
      summary: 's',
      run: (_report, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
    });
    expect(manager.cancel(job.id)).toBe(true);
    expect(manager.cancel(job.id)).toBe(false, 'second cancel is a no-op');
    await new Promise((r) => setTimeout(r, 10));

    expect(sawAbort).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome.status).toBe('cancelled');
    expect(manager.activeCount()).toBe(0);
  });

  it('reports progress and caps settled history', async () => {
    const manager = new JobManager(2);
    const release: Array<(v: string[]) => void> = [];
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const job = manager.start({
        tool: 't',
        summary: `s${i}`,
        run: (report) =>
          new Promise<string[]>((resolve) => {
            report(0.5);
            release.push(resolve);
          }),
      });
      ids.push(job.id);
    }
    for (const resolve of release) resolve([]);
    await new Promise((r) => setTimeout(r, 0));

    // Only the most recent two settled jobs stay queryable.
    expect(manager.get(ids[0])).toBeUndefined();
    expect(manager.get(ids[1])).toBeUndefined();
    expect(manager.get(ids[2])?.status).toBe('done');
    expect(manager.get(ids[3])?.progress).toBe(0.5);
  });
});
