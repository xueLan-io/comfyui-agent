export const AnimateDiffAdapter = {
  name: 'animatediff',
  description: 'AnimateDiff workflow adapter - supports video generation parameters',

  describe(wf) {
    const nodes = wf.nodes || [];
    const adNodes = nodes.filter(n =>
      (n.type || '').includes('AnimateDiff') || (n.type || '').includes('animatediff')
    );
    const vidNode = nodes.find(n =>
      (n.type || '').includes('Video') || (n.type || '').includes('video')
    );
    return {
      modelType: 'animatediff',
      animateDiffNodes: adNodes.map(n => n.type),
      hasVideoOutput: !!vidNode,
      promptSlots: this._countEasyPromptList(nodes),
    };
  },

  prepare(wf, input = {}) {
    const nodes = wf.nodes || [];
    const frames = input.frames ?? input.settings?.frames;
    const fps = input.fps ?? input.settings?.fps;

    for (const node of nodes) {
      if (!node.widgets_values) continue;
      const inputs = node.inputs || [];
      const frameIndex = inputs.findIndex(item => /^(frames|frame_count|length|video_length)$/i.test(item.name || ''));
      const fpsIndex = inputs.findIndex(item => /^(fps|frame_rate|framerate)$/i.test(item.name || ''));
      if (frameIndex >= 0 && frames !== undefined) node.widgets_values[frameIndex] = frames;
      if (fpsIndex >= 0 && fps !== undefined) node.widgets_values[fpsIndex] = fps;
      if (frameIndex < 0 && frames !== undefined && /empty(?:latentimage|advancedlatentimage)/i.test(node.type || '') && node.widgets_values.length >= 3) node.widgets_values[2] = frames;
    }

    return wf;
  },

  _countEasyPromptList(nodes) {
    return nodes
      .filter(n => n.type === 'easy promptList')
      .reduce((sum, n) => sum + (n.widgets_values?.length || 0), 0);
  },
};
