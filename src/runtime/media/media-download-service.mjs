import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { assertServiceOwner } from '../service-policy.mjs';

export class MediaDownloadService {
  constructor({ assetResolver, allowedRoots = [] } = {}) { this.assetResolver = assetResolver; this.allowedRoots = allowedRoots.map(value => resolve(value)); }
  async download({ assetId, owner, outputPath, overwrite = false } = {}) {
    if (!assetId || !outputPath) throw new Error('assetId and outputPath are required');
    const asset = await this.assetResolver?.(assetId, owner);
    if (!asset?.path) throw new Error('Media asset is unavailable');
    assertServiceOwner(asset.owner || {}, owner || {});
    const target = resolve(outputPath);
    if (!this.allowedRoots.some(root => target === root || target.startsWith(`${root}${'\\'}`) || target.startsWith(`${root}/`))) throw new Error('Download target is outside an allowed root');
    if (!overwrite) { try { await access(target); throw new Error('Download target already exists'); } catch (error) { if (error.message === 'Download target already exists') throw error; } }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(asset.path, target);
    return { assetId, path: target, filename: basename(target), sizeBytes: (await stat(target)).size };
  }
}
