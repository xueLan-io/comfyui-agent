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

  async execute(request, { workflowDir, clientId = '', sandboxInput, onProgress } = {}) {
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
      clientId,
    }, { workflowDir, sandboxInput, onProgress });
  }

  async executeToolInput(input, { workflowDir = input.workflowDir, sandboxInput, onProgress } = {}) {
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
      });
    } finally {
      this._promptId = '';
    }
  }

  async cancel() {
    return this.tool.cancel(this._promptId || undefined);
  }
}
