export function img2imgWorkflow(overrides = {}) {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', mode: 0, pos: [0, 0], widgets_values: ['anima-model.safetensors'], inputs: [{ name: 'unet_name', widget: { name: 'unet_name' } }], outputs: [{ name: 'MODEL' }] },
      { id: 2, type: 'CLIPLoader', mode: 0, pos: [200, 0], widgets_values: ['clip-model.safetensors'], inputs: [{ name: 'clip_name', widget: { name: 'clip_name' } }], outputs: [{ name: 'CLIP' }] },
      { id: 3, type: 'VAELoader', mode: 0, pos: [400, 0], widgets_values: ['vae.safetensors'], inputs: [{ name: 'vae_name', widget: { name: 'vae_name' } }], outputs: [{ name: 'VAE' }] },
      { id: 4, type: 'LoraLoaderModelOnly', mode: 0, pos: [0, 200], widgets_values: ['anima-lora.safetensors'], inputs: [{ name: 'lora_name', widget: { name: 'lora_name' } }, { name: 'model', link: 1 }], outputs: [{ name: 'MODEL' }] },
      { id: 5, type: 'LoadImage', mode: 0, pos: [600, 0], widgets_values: ['input.png'], inputs: [{ name: 'image', widget: { name: 'image' } }], outputs: [{ name: 'IMAGE' }] },
      { id: 6, type: 'VAEEncode', mode: 0, pos: [800, 0], widgets_values: [], inputs: [{ name: 'pixels', link: 5 }, { name: 'vae', link: 4 }], outputs: [{ name: 'LATENT' }] },
      { id: 7, type: 'CLIPTextEncode', mode: 0, pos: [0, 400], widgets_values: ['a cat'], inputs: [{ name: 'clip', link: 2 }, { name: 'text', widget: { name: 'text' } }], outputs: [{ name: 'CONDITIONING' }] },
      { id: 8, type: 'CLIPTextEncode', mode: 0, pos: [200, 400], widgets_values: ['bad quality'], inputs: [{ name: 'clip', link: 3 }, { name: 'text', widget: { name: 'text' } }], outputs: [{ name: 'CONDITIONING' }] },
      { id: 9, type: 'KSampler', mode: 0, pos: [0, 600], widgets_values: [42, 28, 7, 'euler_ancestral', 'normal', 0.8], inputs: [{ name: 'model', link: 6 }, { name: 'positive', link: 7 }, { name: 'negative', link: 8 }, { name: 'latent_image', link: 9 }, { name: 'seed', widget: { name: 'seed' } }, { name: 'steps', widget: { name: 'steps' } }, { name: 'cfg', widget: { name: 'cfg' } }, { name: 'sampler_name', widget: { name: 'sampler_name' } }, { name: 'scheduler', widget: { name: 'scheduler' } }, { name: 'denoise', widget: { name: 'denoise' } }], outputs: [{ name: 'LATENT' }] },
      { id: 10, type: 'VAEDecode', mode: 0, pos: [200, 600], widgets_values: [], inputs: [{ name: 'samples', link: 10 }, { name: 'vae', link: 4 }], outputs: [{ name: 'IMAGE' }] },
      { id: 11, type: 'SaveImage', mode: 0, pos: [400, 600], widgets_values: [], inputs: [{ name: 'images', link: 11 }], outputs: [] },
    ],
    links: [
      [1, 1, 0, 4, 1],
      [2, 2, 0, 7, 0],
      [3, 2, 0, 8, 0],
      [4, 3, 0, 6, 1],
      [5, 5, 0, 6, 0],
      [6, 4, 0, 9, 0],
      [7, 7, 0, 9, 1],
      [8, 8, 0, 9, 2],
      [9, 6, 0, 9, 3],
      [10, 9, 0, 10, 0],
      [11, 10, 0, 11, 0],
    ],
    groups: [{ title: 'Sampling', bounding: [-10, 590, 600, 120] }],
    ...overrides,
  };
}

export function img2imgObjectInfo(modelOptions = {}) {
  const options = (name, opts = []) => [opts, {}];
  return {
    UNETLoader: { output_node: false, input: { required: { unet_name: options('unet_name', modelOptions.unet || ['anima-model.safetensors']) }, optional: {} }, input_order: { required: ['unet_name'], optional: [] } },
    CLIPLoader: { input: { required: { clip_name: options('clip_name', modelOptions.clip || ['clip-model.safetensors']) }, optional: {} }, input_order: { required: ['clip_name'], optional: [] } },
    VAELoader: { input: { required: { vae_name: options('vae_name', modelOptions.vae || ['vae.safetensors']) }, optional: {} }, input_order: { required: ['vae_name'], optional: [] } },
    LoraLoaderModelOnly: { input: { required: { lora_name: options('lora_name', modelOptions.lora || ['anima-lora.safetensors']), model: ['MODEL'] }, optional: {} }, input_order: { required: ['lora_name', 'model'], optional: [] } },
    LoadImage: { input: { required: { image: options('image', modelOptions.inputImage || ['input.png']) }, optional: {} }, input_order: { required: ['image'], optional: [] } },
    VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] }, optional: {} }, input_order: { required: ['pixels', 'vae'], optional: [] } },
    CLIPTextEncode: { input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] }, optional: {} }, input_order: { required: ['clip', 'text'], optional: [] } },
    KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: ['STRING'], scheduler: ['STRING'], denoise: ['FLOAT'] }, optional: {} }, input_order: { required: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'], optional: [] } },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] }, optional: {} }, input_order: { required: ['samples', 'vae'], optional: [] } },
    SaveImage: { output_node: true, input: { required: { images: ['IMAGE'] }, optional: {} }, input_order: { required: ['images'], optional: [] } },
  };
}
