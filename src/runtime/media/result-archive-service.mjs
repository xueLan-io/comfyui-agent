import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeMediaReference } from './media-contract.mjs';
import { assertServiceOwner } from '../service-policy.mjs';

export class ResultArchiveService {
  constructor({ projectResolver, mediaResolver, projectStore, taskManager, clock = () => new Date().toISOString() } = {}) { this.projectResolver = projectResolver; this.mediaResolver = mediaResolver; this.projectStore = projectStore; this.taskManager = taskManager; this.clock = clock; }
  async archive({ owner, taskId, result = {}, media = [], signal } = {}) {
    const existingTask = this.taskManager?.get?.(taskId);
    if (existingTask?.archiveStatus === 'archived' && existingTask.result?.archiveStatus === 'archived') {
      return existingTask.result;
    }
    const project = await this.projectResolver?.(owner?.projectId);
    if (!project?.dir) throw new Error('Project is unavailable');
    assertServiceOwner({ principalId: owner.principalId, projectId: project.id || owner.projectId, sessionId: owner.sessionId }, owner);
    const references = [...(media.length ? media : [...(result.images || []), ...(result.videos || []), ...(result.media || [])])]
      .map(item => normalizeMediaReference(item))
      .filter((item, index, all) => index === all.findIndex(candidate => JSON.stringify([candidate.assetId, candidate.path, candidate.filename, candidate.subfolder, candidate.type, candidate.url]) === JSON.stringify([item.assetId, item.path, item.filename, item.subfolder, item.type, item.url])));
    const archived = [];
    const createdFiles = [];
    const tempFiles = [];
    try {
      for (const reference of references) {
        if (signal?.aborted) throw Object.assign(new Error('Archive cancelled'), { code: 'CANCELLED' });
        const sourcePath = await this.mediaResolver?.(reference, owner);
        if (!sourcePath) throw new Error(`Unable to resolve media: ${reference.filename}`);
        const type = reference.mediaType === 'video' ? 'videos' : 'images';
        const filename = `${randomUUID()}-${String(reference.filename || 'result').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const projectRoot = resolve(project.dir);
        const safeTaskId = String(taskId || 'unassigned');
        if (!/^[a-zA-Z0-9_-]+$/.test(safeTaskId)) throw new Error('Invalid task id');
        const target = resolve(projectRoot, type, safeTaskId);
        const targetRelative = relative(projectRoot, target);
        if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) throw new Error('Invalid task id');
        await mkdir(target, { recursive: true });
        const destination = join(target, filename);
        const temporary = `${destination}.tmp-${randomUUID()}`;
        await copyFile(sourcePath, temporary);
        tempFiles.push(temporary);
        await rename(temporary, destination);
        tempFiles.splice(tempFiles.indexOf(temporary), 1);
        createdFiles.push(destination);
        archived.push({ ...reference, assetId: reference.assetId || `asset_${randomUUID()}`, filename, subfolder: `${type}/${taskId || 'unassigned'}`, type: 'project', projectId: project.id || owner.projectId, sessionId: owner.sessionId, taskId, archiveStatus: 'archived', createdAt: this.clock() });
      }
      if (this.projectStore?.updateAssets) await this.projectStore.updateAssets(project.id || owner.projectId, archived);
      const archivedResult = { ...result, archiveStatus: 'archived', media: archived, images: archived.filter(item => item.mediaType === 'image'), videos: archived.filter(item => item.mediaType === 'video') };
      if (this.taskManager?.settleComplete) {
        this.taskManager.update?.(taskId, { archiveStatus: 'archived' });
        this.taskManager.settleComplete(taskId, { result: archivedResult });
      }
      else this.taskManager?.update?.(taskId, { archiveStatus: 'archived', result: archivedResult });
      await this.taskManager?.persist?.();
      return archivedResult;
    } catch (error) {
      await Promise.all(tempFiles.map(file => rm(file, { force: true }).catch(() => {})));
      await Promise.all(createdFiles.map(file => rm(file, { force: true }).catch(() => {})));
      if (error.code === 'CANCELLED') {
        this.taskManager?.update?.(taskId, { archiveStatus: 'cancelled', status: 'cancelled', state: 'cancelled', rawResultAvailable: true, rawResult: result, archiveError: error.message });
        await this.taskManager?.persist?.();
        return { archiveStatus: 'cancelled', rawResultAvailable: true, retryable: false, error: error.message, media: archived };
      }
      this.taskManager?.update?.(taskId, { archiveStatus: 'archive_failed', status: 'archive_failed', state: 'archive_failed', rawResultAvailable: true, rawResult: result, result, archiveError: error.message });
      await this.taskManager?.persist?.();
      return { archiveStatus: 'archive_failed', rawResultAvailable: true, retryable: true, error: error.message, media: archived };
    }
  }
}
