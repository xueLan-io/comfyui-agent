const base = (process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const kind = process.argv[2] || 'unet';
const cases = {
  unet: {
    label: 'UNETLoader',
    prompt: {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'PreviewAny', inputs: { source: ['1', 0] } },
    },
  },
  clip: {
    label: 'CLIPLoader',
    prompt: {
      '1': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'cpu' } },
      '2': { class_type: 'PreviewAny', inputs: { source: ['1', 0] } },
    },
  },
  vae_video: {
    label: 'video VAELoader',
    prompt: {
      '1': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
      '2': { class_type: 'PreviewAny', inputs: { source: ['1', 0] } },
    },
  },
  vae_audio: {
    label: 'audio VAELoader',
    prompt: {
      '1': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
      '2': { class_type: 'PreviewAny', inputs: { source: ['1', 0] } },
    },
  },
};

if (!cases[kind]) throw new Error(`Unknown probe: ${kind}`);
const response = await fetch(`${base}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: cases[kind].prompt }),
});
const body = await response.text();
if (!response.ok) throw new Error(`queue failed (${response.status}): ${body}`);
const { prompt_id: promptId } = JSON.parse(body);
console.log(JSON.stringify({ probe: cases[kind].label, promptId }));

const started = Date.now();
for (;;) {
  let historyResponse;
  try {
    historyResponse = await fetch(`${base}/history/${promptId}`);
  } catch (error) {
    console.error(JSON.stringify({ probe: cases[kind].label, promptId, processFailure: error.message }));
    process.exitCode = 2;
    break;
  }
  const history = await historyResponse.json();
  const result = history[promptId];
  if (result) {
    console.log(JSON.stringify({ probe: cases[kind].label, promptId, status: result.status, outputs: result.outputs }, null, 2));
    if (result.status?.status_str !== 'success') process.exitCode = 1;
    break;
  }
  if (Date.now() - started > 600000) throw new Error('Probe timed out');
  await new Promise(resolve => setTimeout(resolve, 1500));
}
