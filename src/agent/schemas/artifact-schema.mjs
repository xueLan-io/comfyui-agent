let _idCounter = 0;

function nextId() {
  _idCounter++;
  return `art_${Date.now()}_${_idCounter}`;
}

const ArtifactTypes = ['image', 'prompt', 'workflow', 'video', 'model', 'mask', 'text'];

const ArtifactSchema = {
  type: 'object',
  required: ['id', 'type', 'source'],
  properties: {
    id: { type: 'string', description: 'Unique artifact identifier' },
    type: { type: 'string', enum: ArtifactTypes, description: 'Artifact content type' },
    source: {
      type: 'object',
      required: ['taskId', 'tool'],
      properties: {
        taskId: { type: 'string', description: 'Task that produced this artifact' },
        tool: { type: 'string', description: 'Tool that created this artifact' },
        workflowName: { type: 'string', description: 'Workflow filename if applicable' },
        modelType: { type: 'string', description: 'Model family hint (sdxl, flux, etc)' },
        stepId: { type: 'string', description: 'Plan step that produced this artifact' },
      },
    },
    metadata: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        seed: { type: 'number' },
        prompt: { type: 'string' },
        negativePrompt: { type: 'string' },
        guidance: { type: 'number' },
        steps: { type: 'number' },
        modelName: { type: 'string' },
        url: { type: 'string' },
        fileSize: { type: 'number' },
        format: { type: 'string' },
      },
    },
    lineage: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'Parent artifact ID if derived from another' },
        operation: {
          type: 'string',
          enum: ['txt2img', 'img2img', 'enhance', 'inpaint', 'outpaint', 'variation', 'upscale', 'other'],
          description: 'Operation that produced this artifact',
        },
        promptId: { type: 'string', description: 'ComfyUI prompt ID for traceability' },
      },
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'User or system tags for search/filter',
    },
    created: { type: 'number', description: 'Unix timestamp of creation' },
  },
};

function createArtifact(type, source, options = {}) {
  return {
    id: nextId(),
    type,
    source: {
      taskId: source.taskId || '',
      tool: source.tool || '',
      workflowName: source.workflowName || '',
      modelType: source.modelType || '',
      stepId: source.stepId || '',
    },
    metadata: {
      filename: options.filename || '',
      width: options.width || 0,
      height: options.height || 0,
      seed: options.seed || 0,
      prompt: options.prompt || '',
      negativePrompt: options.negativePrompt || '',
      guidance: options.guidance || 0,
      steps: options.steps || 0,
      modelName: options.modelName || '',
      url: options.url || '',
      fileSize: options.fileSize || 0,
      format: options.format || '',
    },
    lineage: {
      parentId: options.parentId || '',
      operation: options.operation || 'txt2img',
      promptId: options.promptId || '',
    },
    tags: options.tags || [],
    created: Date.now(),
  };
}

function artifactFromComfyUIImage(img, source, metadata = {}, baseUrl = 'http://127.0.0.1:8188') {
  const sub = img.subfolder ? `&subfolder=${img.subfolder}` : '';
  const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}${sub}&type=${encodeURIComponent(img.type || 'output')}`;
  return createArtifact('image', source, {
    filename: img.filename,
    url,
    format: img.filename?.split('.').pop() || 'png',
    ...metadata,
  });
}

export { ArtifactSchema, ArtifactTypes, createArtifact, artifactFromComfyUIImage, nextId };
