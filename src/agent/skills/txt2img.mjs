export const Txt2ImgSkill = {
  name: 'txt2img',
  description: 'Text-to-image generation with prompt enhancement and workflow execution',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'cinematic';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: { prompt: userIntent, mode },
        description: `Enhance prompt (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    steps.push({
      tool: 'comfyui',
      input: {
        workflowName: '',
        prompts: [],
        workflowDir: context.workflowDir || '',
      },
      description: 'Execute text-to-image workflow',
      expected_output: 'images',
    });

    return steps;
  },
};
