const MEDIA_TYPES = new Set(['image', 'video']);
const ARCHIVE_STATES = new Set(['ephemeral', 'archiving', 'archived', 'archive_failed', 'downloadable', 'expired']);

export function normalizeMediaReference(input = {}, defaults = {}) {
  const source = input.source || defaults.source || { kind: 'local_file' };
  const mediaType = input.mediaType || defaults.mediaType || (/(mp4|webm|mov|gif)$/i.test(input.filename || input.path || '') ? 'video' : 'image');
  if (!MEDIA_TYPES.has(mediaType)) throw new Error(`Unsupported media type: ${mediaType}`);
  return {
    ...structuredClone(input),
    assetId: input.assetId || defaults.assetId || '',
    mediaType,
    filename: input.filename || input.name || '',
    subfolder: input.subfolder || '',
    type: input.type || defaults.type || 'project',
    source: structuredClone(source),
    archiveStatus: ARCHIVE_STATES.has(input.archiveStatus) ? input.archiveStatus : 'ephemeral',
  };
}

export function assertMediaReference(reference) {
  const value = normalizeMediaReference(reference);
  if (!value.assetId && !value.path && !value.filename) throw new Error('Media reference requires assetId, path, or filename');
  return value;
}

export { MEDIA_TYPES, ARCHIVE_STATES };
