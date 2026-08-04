const VARIATION_HINTS = /(表情|姿势|变体|姿态|表情包|多张|几个|系列|合集|variation|expression|pose|sheet)/i;

export const CharacterSkill = {
  name: 'character',
  description: 'Character design pipeline: generate character sheets, expressions, and variations',
  steps(userIntent, context) {
    const steps = [];
    const wantsVariations = VARIATION_HINTS.test(userIntent);

    steps.push({
      tool: 'prompt_enhance',
      input: {
        prompt: userIntent,
        mode: context.promptMode === 'raw' ? 'concept' : context.promptMode,
        constraints: {
          task: 'character_design',
          preserveCharacterIdentity: true,
          preserveCharacterCount: true,
          preserveCharacterAge: true,
          preserveCharacterClothing: true,
          preserveExplicitCamera: true,
          preserveUserComposition: true,
        },
      },
      description: 'Create character prompt',
      expected_output: 'prompt',
    });

    const input = {
      workflowName: context.workflowName || '',
      prompts: [],
      workflowDir: context.workflowDir || '',
      images: context.images || [],
    };
    if (wantsVariations) input.settings = { batch: context.variationBatch || 4 };

    steps.push({
      tool: 'comfyui',
      input,
      description: wantsVariations ? 'Generate character variations' : 'Generate character concept',
      expected_output: 'images',
    });

    return steps;
  },
};
