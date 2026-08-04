const NAME_RE = /(?:controlnet|控制网络)[:\s]*([\w.-]+)/i;
const STRENGTH_RE = /(?:strength|强度)[:\s]*([\d.]+)/i;

function findControlNetNode(editableNodes = []) {
  return editableNodes.find(node => /controlnet/i.test(node.type || ''));
}

export const ControlNetSkill = {
  name: 'controlnet',
  description: '通过姿态、骨架、深度、线稿等参考图进行控制生成',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'concept';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: { task: 'controlnet', preservePose: true },
        },
        description: `增强提示词用于 ControlNet 控制 (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    const node = findControlNetNode(context.workflowManifest?.editableNodes || []);
    const input = {
      workflowName: context.workflowName || '',
      prompts: [],
      workflowDir: context.workflowDir || '',
      images: context.images || [],
    };

    if (node) {
      const names = new Set((node.inputs || []).map(item => item.name));
      const overrides = {};
      const nameMatch = userIntent.match(NAME_RE);
      if (names.has('control_net_name')) overrides.control_net_name = nameMatch ? nameMatch[1] : '';
      const strengthMatch = userIntent.match(STRENGTH_RE);
      if (names.has('strength')) overrides.strength = strengthMatch ? parseFloat(strengthMatch[1]) : 0.8;
      input.nodeOverrides = { [node.id]: overrides };
    }

    steps.push({
      tool: 'comfyui',
      input,
      description: node
        ? '执行 ControlNet 控制生成工作流'
        : 'ControlNet 控制生成需要工作流中包含 ControlNet 加载节点',
      expected_output: 'images',
    });

    return steps;
  },
};
