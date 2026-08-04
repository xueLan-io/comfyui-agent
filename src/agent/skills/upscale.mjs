const SCALE_RE = /(?:2x|4x)|(\d+(?:\.\d+)?)\s*(?:倍|倍放大|x)?/;
const DIMENSION_RE = /(\d+)\s*[x×*]\s*(\d+)/;

function findUpscaleNode(editableNodes = []) {
  return editableNodes.find(node => /UpscaleImage|ImageScale|UltimateUpscale/i.test(node.type || ''));
}

export const UpscaleSkill = {
  name: 'upscale',
  description: '放大、高清、超分辨率放大图片',
  steps(userIntent, context) {
    const steps = [];
    const mode = context.promptMode || 'concept';

    if (mode !== 'raw') {
      steps.push({
        tool: 'prompt_enhance',
        input: {
          prompt: userIntent,
          mode,
          constraints: { task: 'upscale' },
        },
        description: `增强提示词用于放大 (${mode} mode)`,
        expected_output: 'prompt',
      });
    }

    const node = findUpscaleNode(context.workflowManifest?.editableNodes || []);
    const input = {
      workflowName: context.workflowName || '',
      prompts: [],
      workflowDir: context.workflowDir || '',
      images: context.images || [],
    };

    if (node) {
      const names = new Set((node.inputs || []).map(item => item.name));
      const overrides = {};
      const scaleMatch = userIntent.match(SCALE_RE);
      const scale = scaleMatch ? parseFloat(scaleMatch[1] ?? scaleMatch[0]) : 2;
      const dimension = userIntent.match(DIMENSION_RE);
      if (names.has('scale_by')) overrides.scale_by = scale;
      if (dimension) {
        if (names.has('width') && names.has('height')) {
          overrides.width = parseInt(dimension[1], 10);
          overrides.height = parseInt(dimension[2], 10);
        } else if (names.has('upscale_method')) {
          overrides.upscale_method = 'lanczos';
        }
      }
      input.nodeOverrides = { [node.id]: overrides };
    }

    steps.push({
      tool: 'comfyui',
      input,
      description: node
        ? '执行高清放大工作流'
        : '高清放大需要工作流中包含放大节点（UpscaleImage/ImageScale/UltimateUpscale）',
      expected_output: 'images',
    });

    return steps;
  },
};
