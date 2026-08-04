const NAME_SAFETENSORS_RE = /(?:lora|模型)[:\s]*([\w.-]+\.safetensors)/i;
const NAME_RE = /(?:lora|模型)[:\s]*([\w.-]+)/i;
const STRENGTH_RE = /(?:strength_(model|clip)|lora强度)[:\s]*([\d.]+)/i;

function findLoraNode(editableNodes = []) {
  return editableNodes.find(node => /LoraLoader|LoraLoaderModelOnly/i.test(node.type || ''));
}

export const LoraSkill = {
  name: 'lora',
  description: '加载 LoRA 模型或风格模型',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'concept';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: { task: 'lora', preserveCharacterIdentity: true },
        },
        description: `增强提示词用于 LoRA (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    const node = findLoraNode(context.workflowManifest?.editableNodes || []);
    const input = {
      workflowName: context.workflowName || '',
      prompts: [],
      workflowDir: context.workflowDir || '',
    };

    if (node) {
      const names = new Set((node.inputs || []).map(item => item.name));
      const overrides = {};
      const nameMatch = userIntent.match(NAME_SAFETENSORS_RE) || userIntent.match(NAME_RE);
      if (nameMatch && names.has('lora_name')) overrides.lora_name = nameMatch[1];
      const strengthMatch = userIntent.match(STRENGTH_RE);
      if (strengthMatch) {
        const value = parseFloat(strengthMatch[2]);
        if (strengthMatch[1] === 'clip' && names.has('strength_clip')) overrides.strength_clip = value;
        if (names.has('strength_model')) overrides.strength_model = value;
      }
      input.nodeOverrides = { [node.id]: overrides };
    } else {
      input.nodeOverrides = {};
    }

    steps.push({
      tool: 'comfyui',
      input,
      description: node
        ? '执行带 LoRA 的工作流'
        : 'LoRA 生成需要工作流中包含 LoRA 加载节点',
      expected_output: 'images',
    });

    return steps;
  },
};
