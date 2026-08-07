import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ResultArchiveService } from '../src/runtime/media/result-archive-service.mjs';

test('archive cleans temporary and already-created files after a failed batch', async () => {
  const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'archive-transaction-'));
  const source = join(root, 'source.txt'); await writeFile(source, 'data');
  const task = { updates: [], update(id, patch) { this.updates.push(patch); } };
  try {
    const service = new ResultArchiveService({ projectResolver: async () => ({ id: 'p', dir: root }), mediaResolver: async reference => reference.filename === 'ok.txt' ? source : '', projectStore: { updateAssets: async () => {} }, taskManager: task });
    const result = await service.archive({ owner: { principalId: 'principal', projectId: 'p', sessionId: 's' }, taskId: 'task', media: [{ filename: 'ok.txt', mediaType: 'image' }, { filename: 'missing.txt', mediaType: 'image' }] });
    assert.equal(result.archiveStatus, 'archive_failed');
    assert.equal((await readdir(join(root, 'images', 'task'))).length, 0);
    assert.equal((await readdir(root)).some(name => name.includes('.tmp-')), false);
    assert.equal(task.updates.at(-1).archiveStatus, 'archive_failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
