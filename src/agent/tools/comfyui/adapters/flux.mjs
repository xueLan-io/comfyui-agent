export const FluxAdapter = {
  name: 'flux',
  description: 'Flux model workflow adapter - supports multiple resolutions and guidance',

  describe(wf) {
    const nodes = wf.nodes || [];
    const fluxNodes = nodes.filter(n =>
      n.type.includes('Flux') || n.type.includes('flux')
    );
    return {
      modelType: 'flux',
      fluxNodeTypes: fluxNodes.map(n => n.type),
      promptSlots: this._countEasyPromptList(nodes),
      supportsGuidance: fluxNodes.some(n =>
        n.widgets_values && n.widgets_values.length > 2
      ),
    };
  },

  prepare(wf, input) {
    const nodes = wf.nodes || [];
    const guidance = input.guidance ?? 3.5;
    const resolution = input.size || '1024x1024';

    for (const node of nodes) {
      if (node.type === 'EmptyLatentImage' && node.widgets_values) {
        const parts = resolution.split('x').map(Number);
        if (parts.length === 2) {
          node.widgets_values[0] = parts[1];
          node.widgets_values[1] = parts[0];
        }
      }

      if ((node.type.includes('Flux') || node.type.includes('flux')) && node.widgets_values) {
        const guidanceIdx = node.widgets_values.length >= 3 ? 2 : -1;
        if (guidanceIdx >= 0 && guidance !== undefined) {
          node.widgets_values[guidanceIdx] = guidance;
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
