export type GenerationSource = 'direct' | 'ai';

export interface GenerationExecutionPolicy {
  retry: boolean;
  evaluate: boolean;
  mutatePrompt: boolean;
}

export interface GenerationMediaItem {
  path?: string;
  url?: string;
  filename?: string;
  name?: string;
  subfolder?: string;
  type?: string;
  mediaType?: string;
  kind?: string;
  assetId?: string;
  [key: string]: unknown;
}

export interface GenerationResult {
  media: GenerationMediaItem[];
  images: GenerationMediaItem[];
  videos: GenerationMediaItem[];
  [key: string]: any;
}

export interface GenerationRequest {
  requestId: string;
  turnId: string;
  projectId: string;
  sessionId: string;
  principalId: string;
  tenantId: string;
  source: GenerationSource;
  workflowName: string;
  positive: string;
  negative: string;
  settings: Record<string, any>;
  nodeOverrides: Record<string, any>;
  outputNodeIds: string[] | null;
  media: Record<string, any>;
  outputType: 'video' | 'image' | 'auto';
  origin: string;
  presetId: string;
  presetOrigin: string;
  executionPolicy: GenerationExecutionPolicy;
}

const SOURCES = new Set<string>(['direct', 'ai']);
const VIDEO_EXTENSIONS = /\.(?:mp4|webm|mov|mkv|avi|gif)$/i;

function randomUUID(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function copyObject(value: any): any {
  return value && typeof value === 'object' ? structuredClone(value) : {};
}

export function normalizeGenerationResult(result: Record<string, any> = {}): GenerationResult {
  const explicitImages = Array.isArray(result.images) ? result.images : [];
  const explicitVideos = Array.isArray(result.videos) ? result.videos : [];
  const suppliedMedia = Array.isArray(result.media) ? result.media : [];
  const all = [...explicitImages, ...explicitVideos, ...suppliedMedia];
  const media = all.filter((item: any, index: number, items: any[]) => {
    const key = mediaKey(item, index);
    return items.findIndex((candidate, candidateIndex) => mediaKey(candidate, candidateIndex) === key) === index;
  });
  const isVideo = (item: any) => item?.mediaType === 'video'
    || item?.kind === 'video'
    || VIDEO_EXTENSIONS.test(item?.filename || item?.name || item?.path || '');
  const images = media.filter((item: any) => !isVideo(item));
  const videos = media.filter((item: any) => isVideo(item));
  return { ...result, media, images, videos };
}

function mediaKey(item: unknown, index: number): string {
  if (!item || typeof item !== 'object') return `${index}`;
  const m = item as Record<string, any>;
  const reference = m.path || m.url || m.filename || m.name || index;
  return JSON.stringify([reference, m.subfolder || '', m.type || '', m.mediaType || m.kind || '', m.assetId || '']);
}

export function normalizeGenerationRequest(input: Record<string, any> = {}): GenerationRequest {
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

export function directGenerationRequest(input: Record<string, any> = {}): GenerationRequest {
  return normalizeGenerationRequest({
    ...input,
    source: 'direct',
    executionPolicy: {
      ...(input.executionPolicy || {}),
      mutatePrompt: false,
    },
  });
}

export function assertDirectExecutionPolicy(request: GenerationRequest): GenerationRequest {
  if (request.source !== 'direct') throw new Error('Direct runtime received a non-direct request');
  if (request.executionPolicy.mutatePrompt) {
    throw new Error('Direct runtime cannot enable prompt mutation');
  }
  return request;
}
