export class OllamaProvider {
  constructor({ baseUrl, model, contextWindow = 32768, vision = false }) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = model || 'llama3.2';
    this.contextWindow = contextWindow;
    this.vision = Boolean(vision);
    this._controller = null;
  }

  supportsVision() {
    return this.vision;
  }

  _abortError(reason, timeoutMs) {
    const timedOut = reason === 'timeout';
    const error = new Error(timedOut
      ? `本地模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`
      : '本地模型请求已取消');
    error.code = timedOut ? 'LLM_TIMEOUT' : 'LLM_CANCELLED';
    return error;
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
    let timer;
    let rejectAbort;
    const abortRace = new Promise((_, reject) => { rejectAbort = reject; });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort('timeout');
        reject(this._abortError('timeout', timeoutMs));
      }, timeoutMs);
    });
    const abortFromCaller = () => {
      rejectAbort(this._abortError('cancelled', timeoutMs));
      controller.abort(signal.reason || 'cancelled');
    };
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    // Hard guard: AbortController alone can fail to interrupt a hung fetch on
    // some network stacks, so every blocking await races against explicit
    // timeout/cancellation rejections and can never hang forever.
    const guarded = promise => Promise.race([promise, timeoutPromise, abortRace]);
    let res;
    try {
      res = await guarded(fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
      if (this._controller === controller) this._controller = null;
      if (controller.signal.aborted) throw this._abortError(controller.signal.reason, timeoutMs);
      const detail = String(error?.cause?.message || error?.cause?.code || error?.message || 'unknown connection failure');
      const wrapped = new Error(`无法连接本地模型服务（${this.baseUrl}）：${detail}`);
      wrapped.code = 'LLM_NETWORK_ERROR';
      throw wrapped;
    }

    try {
      if (!res.ok) {
        const text = await guarded(res.text());
        throw new Error(`Ollama API error (${res.status}): ${text.slice(0, 500)}`);
      }

      if (!streaming) {
        const data = await guarded(res.json());
        const usage = {
          inputTokens: Number(data.prompt_eval_count) || 0,
          outputTokens: Number(data.eval_count) || 0,
          totalTokens: (Number(data.prompt_eval_count) || 0) + (Number(data.eval_count) || 0),
        };
        return {
          ...data.message,
          ...(usage.inputTokens || usage.outputTokens ? { usage } : {}),
          finishReason: data.done_reason || 'unknown',
        };
      }

      if (!res.body) throw new Error('Ollama returned an empty streaming response');
      const reader = res.body.getReader();
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let usage = null;
      let finishReason = 'unknown';
      let sawDone = false;
      const readLine = line => {
        const value = line.trim();
        if (!value) return;
        let data;
        try { data = JSON.parse(value); } catch { return; }
        if (data.done === true) {
          sawDone = true;
          finishReason = data.done_reason || 'unknown';
        }
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
        const { done, value } = await guarded(reader.read());
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(readLine);
        if (done) break;
      }
      readLine(buffer);
      if (!sawDone) {
        const error = new Error('本地模型流式响应在完成前中断');
        error.code = 'LLM_STREAM_INTERRUPTED';
        throw error;
      }
      if (!content.trim()) {
        const error = new Error('本地模型返回了空响应');
        error.code = 'EMPTY_MODEL_RESPONSE';
        if (finishReason === 'length') error.budgetExhausted = true;
        throw error;
      }
      return { role: 'assistant', content, ...(usage ? { usage } : {}), finishReason };
    } finally {
      clearTimeout(timer);
      if (this._controller === controller) this._controller = null;
    }
  }

  cancel() {
    this._controller?.abort('cancelled');
  }
}
