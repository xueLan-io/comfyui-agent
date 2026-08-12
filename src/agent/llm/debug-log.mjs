import { appendFileSync } from 'node:fs';

const DEBUG_LOG_PATH = 'C:/Users/Administrator/AppData/Roaming/comfy-agent/llm-debug.log';

export function debugLog(tag, detail) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] [${tag}] ${detail}\n`);
  } catch {}
}
