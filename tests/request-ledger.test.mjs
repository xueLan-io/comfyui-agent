import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestLedger } from '../electron/request-ledger.mjs';

test('request ledger returns the existing entry for duplicate requests', () => {
  const ledger = new RequestLedger();
  const first = ledger.begin('request-1', { source: 'direct', fingerprint: 'same', previewId: 'preview-1' });
  const second = ledger.begin('request-1', { source: 'direct', fingerprint: 'same', previewId: 'preview-2' });

  assert.equal(second, first);
  assert.equal(ledger.snapshot('request-1').previewId, 'preview-1');
});

test('request ledger rejects identity reuse with different request data', () => {
  const ledger = new RequestLedger();
  ledger.begin('request-1', { fingerprint: 'first' });
  assert.throws(() => ledger.begin('request-1', { fingerprint: 'second' }), error => error.code === 'REQUEST_ID_CONFLICT');
});

test('request ledger preserves terminal results', () => {
  const ledger = new RequestLedger();
  ledger.begin('request-1');
  ledger.update('request-1', { state: 'executing', taskId: 'task-1' });
  ledger.complete('request-1', { images: [{ filename: 'image.png' }] });

  const snapshot = ledger.snapshot('request-1');
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.taskId, 'task-1');
  assert.equal(snapshot.result.images.length, 1);
});

test('request ledger persists and reloads entries', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'request-ledger-'));
  try {
    const file = join(dir, 'ledger.json');
    const first = new RequestLedger();
    await first.load(file);
    first.begin('request-1', { source: 'ai', fingerprint: 'same', taskId: 'task-1' });
    first.update('request-1', { state: 'submit_unknown' });
    await first.persist();

    const second = new RequestLedger();
    await second.load(file);
    assert.equal(second.snapshot('request-1').state, 'submit_unknown');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
