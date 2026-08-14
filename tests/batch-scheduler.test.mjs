import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSONFileStore } from '../src/agent/memory/store.mjs';
import { BatchScheduler, expandBatchJobs, randomSeed } from '../src/runtime/batch/batch-scheduler.mjs';

function fakeRunJob({ fail = new Set(), delay = 0, onResult } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (job, { signal, onProgress } = {}) => {
      calls.push({ positive: job.positive, settings: job.settings });
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (fail.has(calls.length - 1)) throw new Error('boom');
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'BATCH_CANCELLED' });
      onProgress?.(50, 'half');
      const result = { images: [{ path: `out_${calls.length}.png`, name: `out_${calls.length}.png` }], promptId: `p${calls.length}` };
      onResult?.(result);
      return result;
    },
  };
}

async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

test('expandBatchJobs creates seeds x combos jobs with merged settings', () => {
  const jobs = expandBatchJobs({
    positive: 'a cat',
    negative: 'blur',
    settings: { steps: 20 },
    seeds: [1, 2],
    combos: [
      { settings: { steps: 30 } },
      { settings: { cfg: 7 }, nodeOverrides: { '5': { input: 'x' } } },
    ],
  });
  assert.equal(jobs.length, 4);
  assert.equal(jobs[0].seed, 1);
  assert.equal(jobs[1].seed, 2);
  assert.deepEqual(jobs[0].settings, { steps: 30, seed: 1 });
  assert.deepEqual(jobs[1].settings, { steps: 30, seed: 2 });
  assert.deepEqual(jobs[2].settings, { steps: 20, cfg: 7, seed: 1 });
  assert.ok(jobs.every(job => job.status === 'pending' && job.positive === 'a cat'));
});

test('expandBatchJobs supports seedCount and rejects empty prompts', () => {
  const jobs = expandBatchJobs({ positive: 'x', seedCount: 3 });
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every(job => Number.isInteger(job.seed)));
  assert.throws(() => expandBatchJobs({ positive: '' }), error => error.code === 'BATCH_REQUIRES_PROMPT');
  assert.equal(typeof randomSeed(), 'number');
});

test('scheduler runs all jobs to completion with bounded concurrency', async () => {
  const runner = fakeRunJob({ delay: 5 });
  const scheduler = new BatchScheduler({ runJob: runner.fn, limits: { maxConcurrency: 2, jobDelayMs: 0 } });
  await scheduler.init();
  const batch = await scheduler.createBatch({ positive: 'x', seedCount: 4, title: 'four' });
  assert.equal(batch.jobs.length, 4);
  await scheduler.start(batch.id);
  const state = scheduler.publicBatch(batch.id);
  assert.equal(state.status, 'completed');
  assert.equal(state.progress.completed, 4);
  assert.equal(state.progress.failed, 0);
  assert.equal(runner.calls.length, 4);
  assert.ok(state.jobs.every(job => job.status === 'completed' && job.result?.images?.length === 1));
});

test('failed jobs are recorded and the rest continue', async () => {
  const runner = fakeRunJob({ fail: new Set([1]) });
  const scheduler = new BatchScheduler({ runJob: runner.fn, limits: { jobDelayMs: 0 } });
  await scheduler.init();
  const batch = await scheduler.createBatch({ positive: 'x', seedCount: 3 });
  await scheduler.start(batch.id);
  const state = scheduler.publicBatch(batch.id);
  assert.equal(state.progress.completed, 2);
  assert.equal(state.progress.failed, 1);
  assert.equal(state.jobs[1].error, 'boom');
});

test('single failed job can be retried and then completes', async () => {
  let call = 0;
  const runner = {
    calls: [],
    fn: async job => {
      call++;
      if (call === 1) throw new Error('transient');
      runner.calls.push(job);
      return { images: [{ path: 'ok.png', name: 'ok.png' }] };
    },
  };
  const scheduler = new BatchScheduler({ runJob: runner.fn, limits: { jobDelayMs: 0 } });
  await scheduler.init();
  const batch = await scheduler.createBatch({ positive: 'x', seedCount: 1 });
  await scheduler.start(batch.id);
  assert.equal(scheduler.publicBatch(batch.id).jobs[0].status, 'failed');
  const jobId = scheduler.publicBatch(batch.id).jobs[0].id;
  await scheduler.retryJob(batch.id, jobId);
  await waitFor(() => scheduler.publicBatch(batch.id).jobs[0].status === 'completed');
  assert.equal(scheduler.publicBatch(batch.id).status, 'completed');
});

test('cancel marks pending jobs cancelled and aborts the running job', async () => {
  let released;
  const gate = new Promise(resolve => { released = resolve; });
  const scheduler = new BatchScheduler({
    runJob: async (job, { signal }) => {
      await Promise.race([gate, new Promise(resolve => signal.addEventListener('abort', resolve))]);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'BATCH_CANCELLED' });
      return { images: [] };
    },
    limits: { maxConcurrency: 1, jobDelayMs: 0 },
  });
  await scheduler.init();
  const batch = await scheduler.createBatch({ positive: 'x', seedCount: 3 });
  const started = scheduler.start(batch.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  await scheduler.cancel(batch.id);
  released();
  await started;
  const state = scheduler.publicBatch(batch.id);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs.filter(job => job.status === 'cancelled').length, 3);
});

test('pause lets the running job finish and resume continues pending jobs', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const scheduler = new BatchScheduler({
    runJob: async (job, { signal }) => {
      calls++;
      if (calls === 1) await Promise.race([firstGate, new Promise(resolve => signal.addEventListener('abort', resolve))]);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'BATCH_CANCELLED' });
      return { images: [] };
    },
    limits: { maxConcurrency: 1, jobDelayMs: 0 },
  });
  await scheduler.init();
  const batch = await scheduler.createBatch({ positive: 'x', seedCount: 3 });
  const running = scheduler.start(batch.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  await scheduler.pause(batch.id);
  releaseFirst();
  await running;
  const paused = scheduler.publicBatch(batch.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.progress.done, 1);
  await scheduler.resume(batch.id);
  assert.equal(scheduler.publicBatch(batch.id).status, 'completed');
  assert.equal(scheduler.publicBatch(batch.id).progress.completed, 3);
});

test('persisted batches recover interrupted jobs after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-batch-'));
  try {
    const store = new JSONFileStore(dir, 'batch.json');
    const runner = fakeRunJob({ delay: 5 });
    const scheduler = new BatchScheduler({ store, runJob: runner.fn, limits: { maxConcurrency: 1, jobDelayMs: 0 } });
    await scheduler.init();
    const batch = await scheduler.createBatch({ positive: 'x', seedCount: 3 });
    // Simulate a crash mid-run: one job marked running, batch marked running.
    scheduler.data.batches[batch.id].status = 'running';
    scheduler.data.batches[batch.id].jobs[0].status = 'running';
    await store.set('data', scheduler.data);
    await store.save();

    const revived = new BatchScheduler({ store, runJob: runner.fn, limits: { maxConcurrency: 2, jobDelayMs: 0 } });
    await revived.init();
    const recovered = revived.publicBatch(batch.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.jobs[0].status, 'interrupted');
    await revived.start(batch.id);
    const done = revived.publicBatch(batch.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.progress.completed, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('batch cap rejects oversized batches and evicts old terminal batches', async () => {
  const scheduler = new BatchScheduler({ runJob: async () => ({ images: [] }), limits: { maxJobs: 2, maxBatches: 1, jobDelayMs: 0 } });
  await scheduler.init();
  await assert.rejects(() => scheduler.createBatch({ positive: 'x', seedCount: 3 }), error => error.code === 'BATCH_LIMIT_EXCEEDED');
  const first = await scheduler.createBatch({ positive: 'a' });
  await scheduler.start(first.id);
  const second = await scheduler.createBatch({ positive: 'b' });
  assert.ok(!scheduler.data.batches[first.id], 'old terminal batch should be evicted');
  assert.ok(scheduler.data.batches[second.id]);
});
