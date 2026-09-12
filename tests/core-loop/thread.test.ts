import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Thread, threadPath } from '../../src/agent/core-loop/thread.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'core-loop-thread-')).then((dir) => {
    dirs.push(dir);
    return dir;
  });
}

describe('Thread', () => {
  it('appends records, persists JSONL, and replays losslessly', async () => {
    const dir = await tempDir();
    const path = threadPath(dir, 's1');
    const thread = await Thread.load(path);
    let clock = 0;
    const now = () => new Date(1700000000000 + (clock += 1000));

    thread.append({ role: 'user', content: '画一只狐狸', now });
    thread.append({
      role: 'agent',
      content: '',
      toolCall: { id: 'c1', name: 'generate_image', args: { prompt: '狐狸' } },
      now,
    });
    thread.append({
      role: 'tool',
      content: 'job job_ab12 running',
      toolCallId: 'c1',
      toolName: 'generate_image',
      jobId: 'job_ab12',
      now,
    });
    thread.append({
      role: 'system',
      content: 'task_notification',
      jobId: 'job_ab12',
      artifactRefs: [{ id: 'a1', kind: 'image', path: 'out/x.png' }],
      now,
    });
    await thread.flush();

    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(4);

    const replayed = await Thread.load(path);
    expect(replayed.size).toBe(4);
    expect(replayed.all()[0]?.content).toBe('画一只狐狸');
    expect(replayed.all()[1]?.toolCall?.name).toBe('generate_image');
    expect(replayed.all()[2]?.jobId).toBe('job_ab12');
    expect(replayed.all()[3]?.artifactRefs?.[0]?.path).toBe('out/x.png');
    // ids stay stable across replay so UI projections can dedupe by id
    expect(replayed.all()[3]?.id).toBe('m4');
  });

  it('starts empty for a new session and tolerates a torn trailing line', async () => {
    const dir = await tempDir();
    const path = threadPath(dir, 's2');
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'threads'), { recursive: true });
    const good = JSON.stringify({ id: 'm1', ts: 't', role: 'user', content: 'ok' });
    await writeFile(path, `${good}\n{"id":"m2","role":`, 'utf8');

    const thread = await Thread.load(path);
    expect(thread.size).toBe(1);
    expect(thread.all()[0]?.content).toBe('ok');
  });

  it('since() projects incrementally for UI subscriptions', async () => {
    const dir = await tempDir();
    const thread = await Thread.load(threadPath(dir, 's3'));
    thread.append({ role: 'user', content: 'a' });
    thread.append({ role: 'agent', content: 'b' });
    thread.append({ role: 'user', content: 'c' });
    await thread.flush();
    expect(thread.since(1).map((m) => m.content)).toEqual(['b', 'c']);
    expect(thread.since(99)).toEqual([]);
  });
});
