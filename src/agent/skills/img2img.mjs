function detectImg2ImgTask(message = '') {
  if (/(局部重绘|局部|蒙版|遮罩|\bmask|inpaint|修复|消除|抹除|去水印|擦除|去掉)/i.test(message)) return 'inpaint';
  if (/(换背景|更换背景|背景替换|替换背景|把背景|background replacement)/i.test(message)) return 'background_replacement';
  if (/(风格|油画|水彩|水墨|赛博|转绘|改画|模仿.*风格|\bstyle\b)/i.test(message)) return 'style_transfer';
  return 'general';
}

export const Img2ImgSkill = {
  name: 'img2img',
  description: 'Image-to-image generation using a reference image with prompt guidance',
  steps(userIntent, context) {
    const steps = [];
    const task = detectImg2ImgTask(userIntent);
    const mode = context.promptMode || 'concept';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: {
            task,
            preserveSubject: true,
            preserveComposition: context.images?.length > 0,
          },
        },
        description: `Enhance prompt for img2img (${task})`,
        expected_output: 'prompt',
      });
    }

    const taskLabel = {
      inpaint: 'inpainting',
      background_replacement: 'background replacement',
      style_transfer: 'style transfer',
      general: 'image-to-image',
    }[task];
    const taskWorkflow = task === 'inpaint' ? 'inpaint.json' : 'img2img.json';

    steps.push({
      tool: 'comfyui',
      input: {
        workflowName: context.workflowName || taskWorkflow,
        prompts: [],
        workflowDir: context.workflowDir || '',
        images: context.images || [],
        masks: context.masks || [],
      },
      description: `Execute ${taskLabel} workflow`,
      expected_output: 'images',
    });

    return steps;
  },
};
