import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

function safeKey(workflowDir, workflowName) {
  const label = `${resolve(workflowDir)}\u0000${workflowName}`;
  const digest = createHash('sha256').update(label).digest('hex').slice(0, 16);
  return `${String(workflowName).replace(/[^a-zA-Z0-9._-]/g, '_')}-${digest}`;
}

export class WorkflowRevisionStore {
  constructor({ root } = {}) {
    this.root = root;
  }

  directory(workflowDir, workflowName) {
    if (!this.root) throw new Error('Revision store root is required');
    const directory = resolve(this.root, safeKey(workflowDir, workflowName));
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  saveRevision(metadata, content) {
    const directory = this.directory(metadata.workflowDir || resolve(metadata.workflowPath, '..'), metadata.workflowName);
    const revisionId = metadata.revisionId || `revision_${randomUUID()}`;
    const backupFile = join(directory, `${revisionId}.json`);
    const metaFile = join(directory, `${revisionId}.meta.json`);
    writeFileSync(backupFile, content, 'utf8');
    const saved = { ...metadata, revisionId, backupFile, status: metadata.status || 'committed' };
    writeFileSync(metaFile, JSON.stringify(saved, null, 2), 'utf8');
    const manifestFile = join(directory, 'manifest.json');
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { revisions: [] };
    manifest.revisions = [saved, ...(manifest.revisions || []).filter(item => item.revisionId !== revisionId)];
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
    return saved;
  }

  listRevisions(workflowDir, workflowName) {
    const directory = this.directory(workflowDir, workflowName);
    const manifestFile = join(directory, 'manifest.json');
    return existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')).revisions || [] : [];
  }

  getRevision(workflowDir, workflowName, revisionId) {
    return this.listRevisions(workflowDir, workflowName).find(item => item.revisionId === revisionId) || null;
  }
}

export function createWorkflowRevisionStore(options) {
  return new WorkflowRevisionStore(options);
}
