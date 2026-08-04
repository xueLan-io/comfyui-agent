export const VideoSkill = {
  name: 'video',
  description: 'Video generation with explicit motion, timing, and camera direction',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'cinematic';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: {
            task: 'video',
            preserveMotion: true,
            preserveTiming: true,
            preserveCameraMovement: true,
          },
        },
        description: `Enhance prompt for video (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    const input = {
      workflowName: context.workflowName || '',
      prompts: [],
      workflowDir: context.workflowDir || '',
      videos: context.videos || [],
    };
    if (context.frames) input.frames = context.frames;
    if (context.fps) input.fps = context.fps;

    steps.push({
      tool: 'comfyui',
      input,
      description: 'Execute video generation workflow',
      expected_output: 'videos',
    });

    return steps;
  },
};
