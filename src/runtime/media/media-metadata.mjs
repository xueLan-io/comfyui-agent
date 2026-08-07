import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseImageInfo } from '../../agent/tools/comfyui/image-header.mjs';
import { normalizeMediaReference } from './media-contract.mjs';

const VIDEO = /\.(mp4|webm|mov|mkv|avi)$/i;
function mime(format, mediaType) { if (mediaType === 'video') return `video/${format === 'quicktime' ? 'mp4' : format || 'mp4'}`; return format === 'jpeg' ? 'image/jpeg' : `image/${format || 'png'}`; }

export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

export async function inspectMediaFile(filePath, { mediaType } = {}) {
  if (!existsSync(filePath)) return { valid: false, exists: false, error: 'Media file not found' };
  const stat = statSync(filePath); const type = mediaType || (VIDEO.test(filePath) ? 'video' : 'image');
  const result = { valid: true, exists: true, mediaType: type, sizeBytes: stat.size, sha256: await hashFile(filePath), filename: filePath.split(/[\\/]/).pop(), mimeType: mime(filePath.split('.').pop().toLowerCase(), type), metadata: {} };
  if (type === 'image') {
    const info = parseImageInfo(new Uint8Array(await readFile(filePath))) || {};
    Object.assign(result, { format: info.format || 'unknown', width: info.width ?? null, height: info.height ?? null, hasAlpha: Boolean(info.hasAlpha), metadata: info.metadata || {} });
  } else {
    result.format = filePath.split('.').pop().toLowerCase();
    result.videoMetadataAvailable = false;
  }
  return result;
}

export async function inspectMediaReference(reference, { resolvePath } = {}) {
  const media = normalizeMediaReference(reference);
  if (!resolvePath) throw new Error('A media resolver is required');
  const filePath = await resolvePath(media);
  return { ...media, ...(await inspectMediaFile(filePath, { mediaType: media.mediaType })) };
}

export async function compareMediaFiles(leftPath, rightPath, options = {}) {
  const [left, right] = await Promise.all([inspectMediaFile(leftPath, options), inspectMediaFile(rightPath, options)]);
  return { sameContent: left.sha256 && left.sha256 === right.sha256, sameFormat: left.format === right.format, sameDimensions: left.width === right.width && left.height === right.height, sameAlpha: left.hasAlpha === right.hasAlpha, sameSize: left.sizeBytes === right.sizeBytes, left, right, differences: [] };
}
