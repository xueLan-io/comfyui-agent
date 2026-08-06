import { ComfyUITool } from '../../agent/tools/comfyui/index.mjs';

export class ComfyExecutor {
  constructor(tool = ComfyUITool) {
    this.tool = tool;
    this._promptId = '';
  }

  inspect(workflowName, workflowDir) {
    return this.tool.inspectWorkflow(workflowName, workflowDir);
  }

  discover(workflowDir) {
    return this.tool.discover(workflowDir);
  }

  async execute(request, { workflowDir, clientId = '', sandboxInput, onProgress, signal } = {}) {
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
      nodeOverrides: request.nodeOverrides,
      outputNodeIds: request.outputNodeIds || undefined,
      images: request.media?.images || [],
      masks: request.media?.masks || [],
      videos: request.media?.videos || [],
      outputType: request.outputType || 'auto',
      clientId,
    }, { workflowDir, sandboxInput, onProgress, signal });
  }

  async executeToolInput(input, { workflowDir = input.workflowDir, sandboxInput, onProgress, signal } = {}) {
    const progress = data => {
      if (data?.promptId) this._promptId = data.promptId;
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
      this._promptId = '';
    }
  }

  async cancel() {
    return this.tool.cancel(this._promptId || undefined);
  }
}
