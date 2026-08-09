import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { mkdtemp, writeFile as writeTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const base = (process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const steps = Number(process.env.H3_STEPS || 2);
const timeoutMs = Number(process.env.H3_TIMEOUT_MS || 3600000);
const includeAudio = process.env.H3_AUDIO === '1';
const sourcePath = process.env.H3_WORKFLOW_SOURCE
  ? resolve(process.env.H3_WORKFLOW_SOURCE)
  : fileURLToPath(new URL('../workflows/minimax_h3_amd_smoke.json', import.meta.url));
const outputPath = process.env.H3_OUTPUT_PATH
  ? resolve(process.env.H3_OUTPUT_PATH)
  : join(await mkdtemp(join(tmpdir(), 'comfyui-agent-h3-')), 'minimax_h3_amd_smoke.json');

const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const keep = new Set([216, 217, 218, 219, 220, 221, 222, 224, 225, 226, 227, 234, 238, 261]);
const sourceNodes = new Map((source.nodes || []).map(node => [node.id, node]));
const missingNodes = [...keep].filter(id => !sourceNodes.has(id));
if (missingNodes.length) throw new Error(`H3 source workflow is missing nodes: ${missingNodes.join(', ')}`);
const expectedTypes = {
  216: 'VAELoader',
  217: 'VAELoader',
  218: 'VAEDecodeAudio',
  219: 'VAEDecode',
  220: 'KSamplerSelect',
  221: 'BasicGuider',
  222: 'RandomNoise',
  224: 'BasicScheduler',
  225: 'MiniMaxH3ReferenceToVideo',
  226: 'SamplerCustomAdvanced',
  227: 'UNETLoader',
  238: 'CLIPLoader',
  261: 'VHS_VideoCombine',
};
const typeMismatches = Object.entries(expectedTypes)
  .filter(([id, type]) => sourceNodes.get(Number(id))?.type !== type)
  .map(([id, type]) => `${id}: expected ${type}, got ${sourceNodes.get(Number(id))?.type || '(missing)'}`);
if (typeMismatches.length) throw new Error(`H3 source/API node mismatch: ${typeMismatches.join('; ')}`);
const nodes = source.nodes
  .filter(node => keep.has(node.id) && (includeAudio || node.id !== 218))
  .map(node => ({ ...node, mode: 0 }));
nodes.push({
  id: 8,
  type: 'MiniMaxH3SigmaShift',
  mode: 0,
  pos: [950, 420],
  size: [260, 100],
  flags: {},
  order: 0,
  properties: {},
  widgets_values: [12, 3],
  inputs: [
    { name: 'model', type: 'MODEL', link: null },
    { name: 'shift_video', type: 'FLOAT', widget: { name: 'shift_video' }, link: null },
    { name: 'shift_audio', type: 'FLOAT', widget: { name: 'shift_audio' }, link: null },
  ],
  outputs: [{ name: 'MODEL', type: 'MODEL', links: null }],
});

const node = id => nodes.find(item => item.id === id);
node(234).widgets_values = [
  'Generate a short cinematic video of a red sports car driving through a desert road at sunset. The camera tracks beside the car as dust trails behind it, with realistic motion, stable composition, warm golden light, and natural engine and wind sound.'
];
node(216).widgets_values = ['minimax_h3_video_vae_fp16.safetensors'];
node(217).widgets_values = ['minimax_h3_audio_vae_fp32.safetensors'];
node(220).widgets_values = ['res_multistep'];
node(221).widgets_values = [];
node(222).widgets_values = [123456789, 'fixed'];
node(224).widgets_values = ['simple', steps, 1];
node(227).widgets_values = ['minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'default'];
node(238).widgets_values = ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'minimax', 'default'];
node(225).widgets_values = ['', 640, 352, 124, 'match'];
node(261).widgets_values = {
  frame_rate: 24,
  loop_count: 0,
  filename_prefix: 'H3_AMD_SMOKE',
  format: 'video/h264-mp4',
  pix_fmt: 'yuv420p',
  crf: 23,
  save_metadata: true,
  trim_to_audio: false,
  pingpong: false,
  save_output: true,
};

const prompt = {
  '216': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
  '217': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
  '218': { class_type: 'VAEDecodeAudio', inputs: { samples: ['226', 0], vae: ['217', 0] } },
  '219': { class_type: 'VAEDecode', inputs: { samples: ['226', 0], vae: ['216', 0] } },
  '220': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
  '8': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['227', 0], shift_video: 12, shift_audio: 3 } },
  '221': { class_type: 'BasicGuider', inputs: { model: ['8', 0], conditioning: ['225', 0] } },
  '222': { class_type: 'RandomNoise', inputs: { noise_seed: 123456789, control_after_generate: 'fixed' } },
  '224': { class_type: 'BasicScheduler', inputs: { model: ['8', 0], scheduler: 'simple', steps, denoise: 1 } },
  '225': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
    clip: ['238', 0], vae: ['216', 0], audio_vae: ['217', 0],
    prompt: 'Generate a short cinematic video of a red sports car driving through a desert road at sunset. The camera tracks beside the car as dust trails behind it, with realistic motion, stable composition, warm golden light, and natural engine and wind sound.',
    width: 640, height: 352, length: 124, ref_image_size: 'match',
  } },
  '226': { class_type: 'SamplerCustomAdvanced', inputs: {
    noise: ['222', 0], guider: ['221', 0], sampler: ['220', 0], sigmas: ['224', 0], latent_image: ['225', 1],
  } },
  '227': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
  '238': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
  '261': { class_type: 'VHS_VideoCombine', inputs: {
    images: ['219', 0], ...(includeAudio ? { audio: ['218', 0] } : {}), frame_rate: 24, loop_count: 0, filename_prefix: includeAudio ? 'H3_AMD_SMOKE' : 'H3_AMD_FAST',
    format: 'video/h264-mp4', pingpong: false, save_output: true, pix_fmt: 'yuv420p', crf: 23,
    save_metadata: true, trim_to_audio: false,
  } },
};
if (!includeAudio) delete prompt['218'];

const workflow = {
  ...source,
  nodes,
  links: [
    [10001, 227, 0, 8, 0, 'MODEL'],
    [10002, 8, 0, 221, 0, 'MODEL'],
    [10003, 8, 0, 224, 0, 'MODEL'],
  ],
  groups: [],
  version: 0.4,
};
await writeTextFile(outputPath, JSON.stringify(workflow, null, 2));

const infoResponse = await fetch(`${base}/object_info`);
if (!infoResponse.ok) throw new Error(`object_info failed: ${infoResponse.status}`);
const info = await infoResponse.json();
const required = Object.values(prompt).map(item => item.class_type);
const missing = [...new Set(required)].filter(type => !info[type]);
if (missing.length) throw new Error(`Missing core nodes: ${missing.join(', ')}`);

const response = await fetch(`${base}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt }),
});
const body = await response.text();
if (!response.ok) throw new Error(`queue failed (${response.status}): ${body}`);
const queued = JSON.parse(body);
console.log(JSON.stringify({ workflow: outputPath, promptId: queued.prompt_id }, null, 2));

const started = Date.now();
for (;;) {
  try {
    const historyResponse = await fetch(`${base}/history/${queued.prompt_id}`);
    const history = await historyResponse.json();
    const result = history[queued.prompt_id];
    if (result) {
      const output = result.outputs?.['261']?.gifs?.[0];
      let outputFile = null;
      let outputBytes = 0;
      if (output?.fullpath) {
        outputFile = output.fullpath;
        outputBytes = (await stat(output.fullpath)).size;
      }
      console.log(JSON.stringify({
        promptId: queued.prompt_id,
        steps,
        status: result.status?.status_str,
        messages: result.status?.messages,
        audio: includeAudio,
        outputs: result.outputs,
        outputFile,
        outputBytes,
      }, null, 2));
      if (result.status?.status_str !== 'success' || outputBytes <= 0) process.exitCode = 1;
      break;
    }
  } catch (error) {
    console.error(`poll transient error: ${error.message}`);
  }
  if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for H3 smoke test after ${timeoutMs}ms`);
  await new Promise(resolve => setTimeout(resolve, 5000));
}
