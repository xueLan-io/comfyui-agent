export function createFakeComfyUI() {
  const prompts = new Map();
  const progressListeners = new Set();
  let sequence = 0;

  function promptId() { sequence += 1; return `fake-prompt-${sequence}`; }
  function entry(id) {
    const value = prompts.get(id);
    if (!value) throw new Error(`Unknown fake prompt: ${id}`);
    return value;
  }

  return {
    async submit(prompt, clientId = '') {
      const id = promptId();
      prompts.set(id, { id, prompt, clientId, state: 'pending', outputs: {}, error: null });
      return { promptId: id };
    },
    async queue() {
      const values = [...prompts.values()];
      return {
        queue_running: values.filter(value => value.state === 'running').map(value => [0, value.id]),
        queue_pending: values.filter(value => value.state === 'pending').map(value => [0, value.id]),
      };
    },
    async history(id) {
      const value = entry(id);
      return {
        [id]: {
          status: {
            completed: ['completed', 'failed', 'cancelled'].includes(value.state),
            status_str: value.state === 'completed' ? 'success' : value.state,
            messages: value.error ? [['execution_error', { exception_message: value.error }]] : [],
          },
          outputs: value.outputs,
        },
      };
    },
    async interrupt(id = '') {
      const values = id ? [entry(id)] : [...prompts.values()].filter(value => ['pending', 'running'].includes(value.state));
      for (const value of values) value.state = 'cancelled';
    },
    start(id) { entry(id).state = 'running'; },
    complete(id, outputs = { output: { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } }) { const value = entry(id); value.state = 'completed'; value.outputs = outputs; },
    fail(id, error = 'Fake ComfyUI failure') { const value = entry(id); value.state = 'failed'; value.error = error; },
    emitProgress(id, value, max = 100, node = 'KSampler') {
      const event = { type: 'progress', data: { prompt_id: id, value, max, node } };
      for (const listener of progressListeners) listener(event);
    },
    onProgress(listener) { progressListeners.add(listener); return () => progressListeners.delete(listener); },
    snapshot: id => structuredClone(entry(id)),
  };
}
