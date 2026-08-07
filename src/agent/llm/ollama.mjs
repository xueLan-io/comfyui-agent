export class OllamaProvider {
  constructor({ baseUrl, model, contextWindow = 32768 }) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = model || 'llama3.2';
    this.contextWindow = contextWindow;
    this._controller = null;
  }

  async healthCheck({ timeoutMs = 1000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + '/api/tags', { method: 'GET', signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat({ messages, tools, toolChoice, temperature = 0.7, maxTokens = 4096, timeoutMs = 60000, onChunk, signal }) {
    const streaming = typeof onChunk === 'function';
    const body = {
      model: this.model,
      messages,
      stream: streaming,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema || t.parameters,
        },
      }));
    }

    const controller = new AbortController();
    this._controller = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const abortFromCaller = () => controller.abort(signal.reason || 'cancelled');
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
      if (this._controller === controller) this._controller = null;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason === 'timeout'
          ? `本地模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`
          : '本地模型请求已取消';
        throw new Error(reason);
      }
      throw error;
    }

    try {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API error (${res.status}): ${text.slice(0, 500)}`);
      }

      if (!streaming) {
        const data = await res.json();
        const usage = {
          inputTokens: Number(data.prompt_eval_count) || 0,
          outputTokens: Number(data.eval_count) || 0,
          totalTokens: (Number(data.prompt_eval_count) || 0) + (Number(data.eval_count) || 0),
        };
        return { ...data.message, ...(usage.inputTokens || usage.outputTokens ? { usage } : {}) };
      }

      if (!res.body) throw new Error('Ollama returned an empty streaming response');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let usage = null;
      let sawDone = false;
      const readLine = line => {
        const value = line.trim();
        if (!value) return;
        let data;
        try { data = JSON.parse(value); } catch { return; }
        if (data.done === true) sawDone = true;
        if (data.prompt_eval_count != null || data.eval_count != null) {
          usage = {
            inputTokens: Number(data.prompt_eval_count) || 0,
            outputTokens: Number(data.eval_count) || 0,
            totalTokens: (Number(data.prompt_eval_count) || 0) + (Number(data.eval_count) || 0),
          };
        }
        const delta = data.message?.content || '';
        if (delta) {
          content += delta;
          onChunk(delta);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(readLine);
        if (done) break;
      }
      readLine(buffer);
      if (!sawDone) throw new Error('本地模型流式响应被中断');
      return { role: 'assistant', content, ...(usage ? { usage } : {}) };
    } finally {
      clearTimeout(timeout);
      if (this._controller === controller) this._controller = null;
    }
  }

  cancel() {
    this._controller?.abort('cancelled');
  }
}
