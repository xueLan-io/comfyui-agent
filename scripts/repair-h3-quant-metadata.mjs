import { copyFileSync, openSync, readSync, closeSync, writeSync } from 'node:fs';

const path = 'D:/ComfyUI_windows_portable/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const backup = `${path}.before-quant-repair`;
const repairedKeys = [
  'model.layers.1.mlp.up_proj.comfy_quant',
  'model.layers.31.self_attn.k_proj.comfy_quant',
  'model.layers.31.self_attn.o_proj.comfy_quant',
  'model.layers.46.self_attn.k_proj.comfy_quant',
  'model.layers.46.self_attn.o_proj.comfy_quant',
  'model.layers.46.self_attn.q_proj.comfy_quant',
];
const replacement = Buffer.from('{"format": "nvfp4", "full_precision_matrix_mult": true}', 'utf8');

copyFileSync(path, backup);
const fd = openSync(path, 'r+');
try {
  const lengthBuffer = Buffer.alloc(8);
  readSync(fd, lengthBuffer, 0, 8, 0);
  const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
  const headerBuffer = Buffer.alloc(headerLength);
  readSync(fd, headerBuffer, 0, headerLength, 8);
  const header = JSON.parse(headerBuffer.toString('utf8'));
  for (const key of repairedKeys) {
    const entry = header[key];
    if (!entry) throw new Error(`Missing tensor in header: ${key}`);
    const [start, end] = entry.data_offsets;
    if (end - start !== replacement.length) throw new Error(`${key} has ${end - start} bytes, expected ${replacement.length}`);
    const offset = 8 + headerLength + start;
    writeSync(fd, replacement, 0, replacement.length, offset);
    console.log(`repaired ${key} at ${offset}`);
  }
} finally {
  closeSync(fd);
}
console.log(`backup: ${backup}`);
