import process from 'node:process';

const baseUrl = (process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const promptId = process.env.COMFYUI_PROMPT_ID || '';

if (!promptId) {
  console.error('Set COMFYUI_PROMPT_ID to an existing prompt id. This check never submits a new prompt.');
  process.exitCode = 2;
} else {
  const queue = await fetch(`${baseUrl}/queue`).then(response => {
    if (!response.ok) throw new Error(`queue HTTP ${response.status}`);
    return response.json();
  });
  const history = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`).then(response => {
    if (!response.ok) throw new Error(`history HTTP ${response.status}`);
    return response.json();
  });
  const running = (queue.queue_running || []).some(item => item?.[1] === promptId || item?.[0] === promptId);
  const pending = (queue.queue_pending || []).some(item => item?.[1] === promptId || item?.[0] === promptId);
  const entry = history[promptId];
  const status = entry ? 'completed' : running ? 'running' : pending ? 'queued' : 'unknown';
  console.log(JSON.stringify({ baseUrl, promptId, status, hasOutputs: Boolean(entry?.outputs && Object.keys(entry.outputs).length) }, null, 2));
}
