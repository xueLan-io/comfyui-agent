function generationSkill({ id, name, aliases = [], keywords, workflowName, modes = ['img2img'], inputs = ['prompt', 'image'] }) {
  return {
    id, name, aliases, description: name, version: '1.0.0', keywords,
    capabilities: { inputs, outputs: ['images'], modes, operations: ['generation'], sideEffects: ['comfyui_generation'], requiresConfirmation: true },
    requirements: { media: inputs.includes('image') ? [{ type: 'image', required: true, minCount: 1 }] : [], workflowCapabilities: modes },
    steps(userIntent, context = {}) {
      return [{ tool: 'comfyui', skill: id, input: { workflowName: context.workflowName || workflowName, workflowDir: context.workflowDir || '', prompts: [], images: context.images || [], masks: context.masks || [] }, description: name, expected_output: 'images' }];
    },
  };
}

export const HighFrequencySkills = {
  inpaint: generationSkill({ id: 'inpaint', name: '局部重绘', aliases: ['局部重绘', '修补'], keywords: ['局部重绘', 'inpaint', '修补'], workflowName: 'inpaint.json', modes: ['inpaint'], inputs: ['prompt', 'image', 'mask'] }),
  outpaint: generationSkill({ id: 'outpaint', name: '扩图', aliases: ['扩图', '向外扩展'], keywords: ['扩图', 'outpaint', '向外扩展'], workflowName: 'inpaint.json', modes: ['inpaint'], inputs: ['prompt', 'image', 'mask'] }),
  background_replace: generationSkill({ id: 'background_replace', name: '背景替换', aliases: ['换背景', '背景替换'], keywords: ['换背景', '背景替换', 'background replacement'], workflowName: 'img2img.json' }),
  style_transfer: generationSkill({ id: 'style_transfer', name: '风格迁移', aliases: ['风格迁移'], keywords: ['风格迁移', 'style transfer', '转换画风'], workflowName: 'img2img.json' }),
  product_catalog: generationSkill({ id: 'product_catalog', name: 'Product Catalog', keywords: ['产品图', '电商图', 'product photo', 'catalog'], workflowName: 'img2img.json' }),
  thumbnail_batch: generationSkill({ id: 'thumbnail_batch', name: 'Thumbnail Batch', keywords: ['缩略图批量', 'thumbnail batch'], workflowName: 'img2img.json' }),
};
