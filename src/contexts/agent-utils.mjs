// Pure helpers extracted from AgentContext.jsx (2026-08-14). These are
// deterministic utilities shared by the provider; keeping them in a separate
// module lets the context file focus on state and effects.
import { normalizeRuntimeStatus, buildRuntimeView } from '../runtime/runtime-status.mjs';
import { isActive as isPhaseActive } from '../runtime/generation-state-machine.mjs';
import { normalizeGenerationResult } from '../runtime/generation-contract.mjs';

export const TOOL_LABELS = {
  comfyui: 'ComfyUI',
  prompt_enhance: '提示词优化',
  filesystem: '文件系统',
  web: 'Web research',
  evaluator: '结果评估',
  planning: '任务规划',
};

export function normalizeUiStatus(status = '') {
  return normalizeRuntimeStatus(status);
}

export function isTaskActive(status, generationPhase = 'idle') {
  return buildRuntimeView({ rawStatus: status, generationPhase }).busy || isPhaseActive(generationPhase);
}

export function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function toolLabel(tool) {
  return TOOL_LABELS[tool] || tool || '';
}

export function eventErrorText(data) {
  if (!data) return '';
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return data.error.message;
  return data.message || '';
}

export function buildGraphSteps(events) {
  const steps = new Map();

  events.forEach((event, index) => {
    if (!event.status || (!event.tool && event.stage !== 'planning')) return;
    const key = event.stepId || event.tool || event.stage || `event-${index}`;
    const previous = steps.get(key);
    steps.set(key, {
      ...previous,
      ...event,
      _key: key,
      _order: previous?._order ?? index,
    });
  });

  return [...steps.values()].sort((a, b) => a._order - b._order);
}

export function assetKey(image = {}) {
  return JSON.stringify([
    image.assetId,
    image.path,
    image.url,
    image.type,
    image.projectId,
    image.sessionId,
    image.taskId,
    image.subfolder,
    image.filename || image.name,
    image.mediaType || image.kind,
  ].map(value => value ?? ''));
}

export function mergeAssets(current, next) {
  const merged = new Map((current || []).map(image => [
    assetKey(image),
    image,
  ]));
  (next || []).forEach(image => merged.set(
    assetKey(image),
    image,
  ));
  return [...merged.values()];
}

export function messageKey(message = {}) {
  return message.messageId || message.id || (message.turnId ? `${message.turnId}:${message.role || ''}` : '');
}

export function mergeConversation(current = [], incoming = []) {
  const merged = new Map();
  for (const message of current) {
    const key = messageKey(message);
    merged.set(key || `current:${merged.size}`, message);
  }
  for (const message of incoming) {
    const key = messageKey(message);
    if (key) merged.set(key, { ...merged.get(key), ...message });
    else merged.set(`incoming:${merged.size}`, message);
  }
  return [...merged.values()];
}

export function resultMedia(result = {}) {
  const images = Array.isArray(result.images) ? result.images : [];
  const videos = Array.isArray(result.videos) ? result.videos : [];
  const supplied = Array.isArray(result.media) ? result.media : [];
  const all = [...images, ...videos, ...supplied];
  return normalizeGenerationResult({ ...result, media: all }).media || [];
}

export function nonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

export function firstNonEmptyObject(...values) {
  return values.find(nonEmptyObject) || {};
}

export function messageAttachments(items = []) {
  return items
    .filter(item => item?.name || item?.path)
    .map(item => ({
      name: item.name || item.path.split(/[\\/]/).pop(),
      kind: item.kind || 'image',
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
    }));
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export function collectRequestImages(text, media) {
  const images = [...media.images];
  const paths = new Set(images.map(item => item?.path).filter(Boolean));
  const pathPattern = /(?:"([A-Za-z]:\\[^"\r\n]+|\/[^"\r\n]+)"|'([A-Za-z]:\\[^'\r\n]+|\/[^'\r\n]+)'|((?:[A-Za-z]:\\|\/)[^\s"']+))/g;
  for (const match of String(text || '').matchAll(pathPattern)) {
    const path = match[1] || match[2] || match[3];
    const extension = `.${path.split('.').pop().toLowerCase()}`;
    if (!IMAGE_EXTENSIONS.has(extension) || paths.has(path)) continue;
    paths.add(path);
    images.push({ path, name: path.split(/[\\/]/).pop(), kind: 'image' });
  }
  return images;
}

export function requestMedia(text, attachments) {
  const media = {
    images: attachments.filter(item => item.kind === 'image'),
    videos: attachments.filter(item => item.kind === 'video'),
  };
  return {
    ...media,
    images: collectRequestImages(text, media),
  };
}

export function newTurnId() {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
