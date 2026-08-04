function splitVariants(message) {
  if (message.includes('|')) return message.split('|').map(item => item.trim()).filter(Boolean);
  return [message, `${message}, cinematic lighting, detailed`];
}

function findBatchSampler(editableNodes = []) {
  return editableNodes.find(node =>
    /KSampler/i.test(node.type || '') && (node.inputs || []).some(item => item.name === 'batch_size'));
}

export const BatchSkill = {
  name: 'batch',
  description: '一次生成多个变体方案进行对比',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'concept';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: { task: 'batch', generateVariants: true },
        },
        description: `增强提示词用于多方案对比 (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    const variants = splitVariants(userIntent);
    const input = {
      workflowName: context.workflowName || '',
      prompts: variants,
      workflowDir: context.workflowDir || '',
    };

    const sampler = findBatchSampler(context.workflowManifest?.editableNodes || []);
    if (sampler) {
      input.nodeOverrides = { [sampler.id]: { batch_size: variants.length } };
    }

    steps.push({
      tool: 'comfyui',
      input,
      description: '多方案对比：一次生成多个变体',
      expected_output: 'images',
    });

    return steps;
  },
};
