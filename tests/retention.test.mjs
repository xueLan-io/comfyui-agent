import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRetention, planRetention, shouldDelete } from '../src/runtime/governance/retention.mjs';

test('retention protects active and recoverable records', () => {
  const now = 100 * 24 * 60 * 60 * 1000;
  assert.equal(shouldDelete({ updatedAt: 0, active: true }, { now, days: 30 }), false);
  assert.equal(shouldDelete({ updatedAt: 1 }, { now, days: 30 }), true);
  assert.deepEqual(planRetention([{ updatedAt: 1, bytes: 10 }, { updatedAt: 1, recoverable: true }], { now, days: 30 }), { dryRun: true, count: 1, bytes: 10, records: [{ updatedAt: 1, bytes: 10 }] });
});

test('retention execution is dry-run by default and continues after delete failures', async () => {
  const audit = []; const plan = { dryRun: false, records: [{ id: 'a', bytes: 4 }, { id: 'b', bytes: 8 }] };
  const report = await executeRetention(plan, { remove: async record => { if (record.id === 'b') throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }, audit: async event => audit.push(event) });
  assert.deepEqual(report, { dryRun: false, attempted: 2, deleted: 1, failed: 1, bytes: 4, errors: [{ id: 'b', code: 'EBUSY', message: 'locked' }] });
  assert.equal(audit.length, 2);
});
