import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeMediaReference } from './media-contract.mjs';
import { assertServiceOwner } from '../service-policy.mjs';

export class ResultArchiveService {
  constructor({ projectResolver, mediaResolver, projectStore, taskManager, clock = () => new Date().toISOString() } = {}) { this.projectResolver = projectResolver; this.mediaResolver = mediaResolver; this.projectStore = projectStore; this.taskManager = taskManager; this.clock = clock; }
  async archive({ owner, taskId, result = {}, media = [], signal } = {}) {
    const project = await this.projectResolver?.(owner?.projectId);
    if (!project?.dir) throw new Error('Project is unavailable');
    assertServiceOwner({ principalId: owner.principalId, projectId: project.id || owner.projectId, sessionId: owner.sessionId }, owner);
    const references = [...(media.length ? media : [...(result.images || []), ...(result.videos || []), ...(result.media || [])])].map(item => normalizeMediaReference(item));
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
        const target = join(resolve(project.dir, type), String(taskId || 'unassigned'));
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
      this.taskManager?.update?.(taskId, { archiveStatus: 'archived', result: { ...result, media: archived, images: archived.filter(item => item.mediaType === 'image'), videos: archived.filter(item => item.mediaType === 'video') } });
      return { archiveStatus: 'archived', media: archived };
    } catch (error) {
      await Promise.all(tempFiles.map(file => rm(file, { force: true }).catch(() => {})));
      await Promise.all(createdFiles.map(file => rm(file, { force: true }).catch(() => {})));
      this.taskManager?.update?.(taskId, { archiveStatus: 'archive_failed', rawResultAvailable: true, archiveError: error.message });
      return { archiveStatus: 'archive_failed', rawResultAvailable: true, retryable: true, error: error.message, media: archived };
    }
  }
}
