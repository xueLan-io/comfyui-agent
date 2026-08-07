import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function bufferHash(buffer) {
  return buffer === null ? null : `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function atomicReplace({ targetPath, content, expectedHash } = {}) {
  const current = existsSync(targetPath) ? readFileSync(targetPath) : null;
  const actualHash = bufferHash(current);
  if (expectedHash !== undefined && String(expectedHash).toLowerCase() !== String(actualHash).toLowerCase()) {
    const error = new Error('File changed during atomic replace');
    error.code = 'FILE_CONFLICT';
    error.expectedHash = expectedHash;
    error.actualHash = actualHash;
    throw error;
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const tempPath = `${targetPath}.agent-tmp-${randomUUID()}`;
  writeFileSync(tempPath, buffer, { flag: 'wx' });
  try {
    try {
      renameSync(tempPath, targetPath);
      return { beforeHash: actualHash, afterHash: bufferHash(buffer) };
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    const backupPath = `${targetPath}.agent-backup-${randomUUID()}`;
    renameSync(targetPath, backupPath);
    try {
      renameSync(tempPath, targetPath);
      rmSync(backupPath, { force: true });
    } catch (error) {
      try { renameSync(backupPath, targetPath); } catch {}
      throw error;
    }
    return { beforeHash: actualHash, afterHash: bufferHash(buffer) };
  } finally {
    rmSync(tempPath, { force: true });
  }
}
