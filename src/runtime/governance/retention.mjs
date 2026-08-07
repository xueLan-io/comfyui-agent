export const DEFAULT_RETENTION_DAYS = Object.freeze({ audit: 90, trace: 30, requestLedger: 30, failedRecovery: 90, artifacts: 30, metrics: 15, policyConfig: 180 });

export function retentionCutoff(now = Date.now(), days = 30) { return now - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000; }

export function shouldDelete(record = {}, { now = Date.now(), days = 30 } = {}) {
  if (record.active || record.recoverable || record.legalHold || record.protected) return false;
  const timestamp = Number(record.updatedAt || record.completedAt || record.createdAt || 0);
  return timestamp > 0 && timestamp < retentionCutoff(now, days);
}

export function planRetention(records = [], options = {}) {
  const deletable = records.filter(record => shouldDelete(record, options));
  return { dryRun: options.dryRun !== false, count: deletable.length, bytes: deletable.reduce((total, record) => total + Math.max(0, Number(record.bytes) || 0), 0), records: deletable };
}

export async function executeRetention(plan, { remove = async () => {}, audit, continueOnError = true } = {}) {
  const report = { dryRun: plan?.dryRun !== false, attempted: 0, deleted: 0, failed: 0, bytes: 0, errors: [] };
  if (report.dryRun) return { ...report, planned: plan?.count || 0, bytes: plan?.bytes || 0 };
  for (const record of plan?.records || []) {
    report.attempted += 1;
    try {
      await remove(record);
      report.deleted += 1;
      report.bytes += Math.max(0, Number(record.bytes) || 0);
      await audit?.({ action: 'retention.deleted', decision: 'allow', data: { id: record.id || '', bytes: record.bytes || 0 } });
    } catch (error) {
      report.failed += 1;
      report.errors.push({ id: record.id || '', code: error.code || 'RETENTION_DELETE_FAILED', message: error.message || String(error) });
      await audit?.({ action: 'retention.deleted', decision: 'error', reason: error.code || error.message, data: { id: record.id || '' } }).catch(() => {});
      if (!continueOnError) throw error;
    }
  }
  return report;
}
