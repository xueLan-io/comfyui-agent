export const AnimateDiffAdapter = {
  name: 'animatediff',
  description: 'AnimateDiff workflow adapter - supports video generation parameters',

  describe(wf) {
    const nodes = wf.nodes || [];
    const adNodes = nodes.filter(n =>
      n.type.includes('AnimateDiff') || n.type.includes('animatediff')
    );
    const vidNode = nodes.find(n =>
      n.type.includes('Video') || n.type.includes('video')
    );
    return {
      modelType: 'animatediff',
      animateDiffNodes: adNodes.map(n => n.type),
      hasVideoOutput: !!vidNode,
      promptSlots: this._countEasyPromptList(nodes),
    };
  },

  prepare(wf, input) {
    const nodes = wf.nodes || [];
    const frames = input.frames ?? 16;
    const fps = input.fps ?? 8;

    for (const node of nodes) {
      if (node.type === 'EmptyLatentImage' && node.widgets_values) {
        if (node.widgets_values.length >= 3) {
          node.widgets_values[2] = frames;
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
