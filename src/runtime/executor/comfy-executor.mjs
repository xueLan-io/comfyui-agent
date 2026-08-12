import { ComfyUITool } from '../../agent/tools/comfyui/index.mjs';

export class ComfyExecutor {
  constructor(tool = ComfyUITool) {
    this.tool = tool;
    this._promptIds = new Map();
  }

  inspect(workflowName, workflowDir) {
    return this.tool.inspectWorkflow(workflowName, workflowDir);
  }

  discover(workflowDir) {
    return this.tool.discover(workflowDir);
  }

  async execute(request, { workflowDir, clientId = '', sandboxInput, onProgress, signal, executionId = '' } = {}) {
    return this.executeToolInput({
      workflowName: request.workflowName,
      workflowDir,
      prompt: request.positive,
      negativePrompt: request.negative,
      compiledPrompt: {
        positive: request.positive,
        positivePrompts: [request.positive],
        negative: request.negative,
      },
      settings: request.settings,
      frames: request.settings?.frames,
      fps: request.settings?.fps,
      nodeOverrides: request.nodeOverrides,
      outputNodeIds: request.outputNodeIds || undefined,
      images: request.media?.images || [],
      masks: request.media?.masks || [],
      videos: request.media?.videos || [],
      outputType: request.outputType || 'auto',
      clientId,
    }, { workflowDir, sandboxInput, onProgress, signal, executionId });
  }

  async executeToolInput(input, { workflowDir = input.workflowDir, sandboxInput, onProgress, signal, executionId = '' } = {}) {
    const id = executionId || `execution_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const progress = data => {
      if (data?.promptId) this._promptIds.set(id, data.promptId);
      onProgress?.({ scope: 'generation', ...data });
    };
    try {
      return await this.tool.execute({
        ...input,
        workflowDir,
        sandboxInput,
        onProgress: progress,
        signal,
      });
    } finally {
      this._promptIds.delete(id);
    }
  }

  async cancel(executionId = '') {
    const promptId = executionId ? this._promptIds.get(executionId) : '';
    if (!promptId) return { status: 'cancelled', promptId: '', pending: true };
    return this.tool.cancel(promptId);
  }
}
