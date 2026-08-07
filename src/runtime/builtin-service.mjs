export const ComfyUIGenerationServiceManifest = {
  contractVersion: '1.0', serviceId: 'comfyui-generation', name: 'ComfyUI Generation', version: '1.0.0', kind: 'local',
  workflow: { capabilities: ['txt2img', 'img2img', 'inpaint'], revisionRequired: false },
  inputs: { workflowName: { type: 'string', required: true }, positive: { type: 'string', required: true }, negative: { type: 'string', required: false }, settings: { type: 'object', required: false } },
  outputs: { images: { type: 'array' }, videos: { type: 'array' }, media: { type: 'array' } },
  execution: { prepareRequired: true, requiresConfirmation: true, timeoutMs: 600000 },
  permissions: { prepare: 'read', invoke: 'execute', status: 'read', cancel: 'execute', result: 'read', archive: 'mutate', download: 'read' },
  limits: { maxBatch: 16, maxOutputBytes: 500000000, maxDurationMs: 600000 },
};

export function createComfyUIGenerationService({ directService, requestLedger, taskManager, manifest = ComfyUIGenerationServiceManifest } = {}) {
  return {
    manifest,
    async normalizeInput(input) { return structuredClone(input); },
    async invoke({ normalizedInput, requestId, owner }) {
      if (!directService) return { state: 'queued', requestId, owner, error: 'DirectService is unavailable' };
      const preview = await directService.prepare({ ...normalizedInput, requestId, projectId: owner?.projectId, sessionId: owner?.sessionId });
      return { state: 'prepared', requestId, previewId: preview.previewId, preview };
    },
    status({ requestId }) { return requestLedger?.snapshot(requestId) || { requestId, state: 'unknown' }; },
    result({ requestId }) { return requestLedger?.snapshot(requestId)?.result || null; },
    async cancel({ requestId, taskId }) { await directService?.cancel?.(); return { requestId, taskId, state: 'cancel_requested' }; },
    taskManager,
  };
}
