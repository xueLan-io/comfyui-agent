export const SDXLAdapter = {
  name: 'sdxl',
  description: 'SDXL workflow adapter - supports 1024x1024 base + refiner',

  describe(wf) {
    const nodes = wf.nodes || [];
    const hasRefiner = nodes.some(n => n.type.includes('Refiner') || n.type.includes('refiner'));
    const ckptNode = nodes.find(n => n.type === 'CheckpointLoaderSimple' || n.type === 'easy control');
    return {
      modelType: 'sdxl',
      resolution: '1024x1024 (base)',
      hasRefiner,
      checkpoint: ckptNode?.widgets_values?.[0] || 'unknown',
      promptSlots: this._countEasyPromptList(nodes),
    };
  },

  prepare(wf, input) {
    const nodes = wf.nodes || [];
    const resolution = input.size || '1024x1024';

    for (const node of nodes) {
      if (node.type === 'EmptyLatentImage' && node.widgets_values) {
        const parts = resolution.split('x').map(Number);
        if (parts.length === 2) {
          node.widgets_values[0] = parts[1];
          node.widgets_values[1] = parts[0];
        }
      }
    }

    return wf;
  },

  _countEasyPromptList(nodes) {
    return nodes
      .filter(n => n.type === 'easy promptList')
      .reduce((sum, n) => sum + (n.widgets_values?.length || 0), 0);
  },
};
