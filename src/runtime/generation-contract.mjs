import { randomUUID } from 'node:crypto';

const SOURCES = new Set(['direct', 'ai']);
const VIDEO_EXTENSIONS = /\.(?:mp4|webm|mov|mkv|avi|gif)$/i;

function copyObject(value) {
  return value && typeof value === 'object' ? structuredClone(value) : {};
}

export function normalizeGenerationResult(result = {}) {
  const explicitImages = Array.isArray(result.images) ? result.images : [];
  const explicitVideos = Array.isArray(result.videos) ? result.videos : [];
  const suppliedMedia = Array.isArray(result.media) ? result.media : [];
  const media = [...explicitImages, ...explicitVideos, ...suppliedMedia].filter((item, index, items) => {
    const key = mediaKey(item, index);
    return items.findIndex((candidate, candidateIndex) => mediaKey(candidate, candidateIndex) === key) === index;
  });
  const isVideo = item => item?.mediaType === 'video'
    || item?.kind === 'video'
    || VIDEO_EXTENSIONS.test(item?.filename || item?.name || item?.path || '');
  const images = media.filter(item => !isVideo(item));
  const videos = media.filter(isVideo);
  return { ...result, media, images, videos };
}

function mediaKey(item, index) {
  if (!item || typeof item !== 'object') return `${index}`;
  const reference = item.path || item.url || item.filename || item.name || index;
  return JSON.stringify([reference, item.subfolder || '', item.type || '', item.mediaType || item.kind || '', item.assetId || '']);
}

export function normalizeGenerationRequest(input = {}) {
  const source = input.source || 'direct';
  if (!SOURCES.has(source)) throw new Error(`Unsupported generation source: ${source}`);
  if (typeof input.workflowName !== 'string' || !input.workflowName.trim()) {
    throw new Error('Workflow name is required');
  }
  if (typeof input.positive !== 'string') throw new Error('Positive prompt must be a string');
  if (typeof input.negative !== 'string') throw new Error('Negative prompt must be a string');

  return {
    requestId: input.requestId || randomUUID(),
    turnId: input.turnId || '',
    projectId: input.projectId || '',
    sessionId: input.sessionId || '',
    principalId: input.principalId || '',
    tenantId: input.tenantId || '',
    source,
    workflowName: input.workflowName,
    positive: input.positive,
    negative: input.negative,
    settings: {
      ...copyObject(input.settings),
      ...(input.frames !== undefined && input.settings?.frames === undefined ? { frames: input.frames } : {}),
      ...(input.fps !== undefined && input.settings?.fps === undefined ? { fps: input.fps } : {}),
    },
    nodeOverrides: copyObject(input.nodeOverrides),
    outputNodeIds: Array.isArray(input.outputNodeIds) ? [...input.outputNodeIds] : null,
    media: copyObject(input.media),
    outputType: input.outputType === 'video' ? 'video' : input.outputType === 'image' ? 'image' : 'auto',
    origin: input.origin || source,
    presetId: input.presetId || '',
    presetOrigin: input.presetOrigin || '',
    executionPolicy: {
      retry: input.executionPolicy?.retry ?? source !== 'direct',
      evaluate: input.executionPolicy?.evaluate ?? source !== 'direct',
      mutatePrompt: input.executionPolicy?.mutatePrompt ?? source !== 'direct',
    },
  };
}

export function directGenerationRequest(input = {}) {
  return normalizeGenerationRequest({
    ...input,
    source: 'direct',
    executionPolicy: {
      ...(input.executionPolicy || {}),
      mutatePrompt: false,
    },
  });
}

export function assertDirectExecutionPolicy(request) {
  if (request.source !== 'direct') throw new Error('Direct runtime received a non-direct request');
  if (request.executionPolicy.mutatePrompt) {
    throw new Error('Direct runtime cannot enable prompt mutation');
  }
  return request;
}
