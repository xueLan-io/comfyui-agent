function validateRequestHeaders(headers) {
  for (const [name, value] of Object.entries(headers)) {
    const stringValue = String(value);
    if ([...stringValue].some(character => character.codePointAt(0) > 255)) {
      if (name.toLowerCase() === 'authorization') {
        throw new Error('Saved API key could not be decrypted. Re-enter it in Settings.');
      }
      throw new Error(`Custom request header "${name}" contains unsupported characters.`);
    }
  }
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, model, apiKey, apiKeyError = '', headers = {}, reasoningEffort = '', local = false, contextWindow = 32768 }) {
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    try {
      const url = new URL(this.baseUrl);
      if (url.pathname === '' || url.pathname === '/') this.baseUrl += '/v1';
    } catch {}
    this.model = model || 'gpt-4o';
    this.apiKey = apiKey || '';
    this.apiKeyError = apiKeyError;
    this.headers = headers;
    this.reasoningEffort = reasoningEffort;
    this.local = local;
    this.contextWindow = contextWindow;
    this._controller = null;
  }

  async healthCheck({ timeoutMs = 1000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {}),
        ...this.headers,
      };
      const res = await fetch(this.baseUrl + '/models', { method: 'GET', headers, signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat({ messages, tools, toolChoice, temperature = 0.7, maxTokens = 4096, timeoutMs = 60000, onChunk }) {
    if (this.apiKeyError) throw new Error(this.apiKeyError);
    const streaming = typeof onChunk === 'function';

    const body = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: streaming,
      ...(this.local ? { thinking: false } : {}),
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (this.reasoningEffort && !this.local) body.reasoning_effort = this.reasoningEffort;
    const controller = new AbortController();
    this._controller = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    let res;
    try {
      const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...this.headers,
      };
      validateRequestHeaders(requestHeaders);
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (this._controller === controller) this._controller = null;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason === 'timeout'
          ? `语言模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`
          : '语言模型请求已取消';
        throw new Error(reason);
      }
      throw error;
    }

    try {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error (${res.status}): ${text.slice(0, 500)}`);
      }

      if (!streaming) {
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`LLM API returned a non-JSON response from ${this.baseUrl}`);
        }
        if (!data.choices?.[0]?.message) throw new Error('LLM API response is missing choices[0].message');
        return data.choices[0].message;
      }

      if (!res.body) throw new Error('LLM API returned an empty streaming response');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const readLine = line => {
        const value = line.trim();
        if (!value || !value.startsWith('data:')) return;
        const payload = value.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let data;
        try { data = JSON.parse(payload); } catch { return; }
        const delta = data.choices?.[0]?.delta?.content || '';
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
      return { role: 'assistant', content };
    } finally {
      clearTimeout(timeout);
      if (this._controller === controller) this._controller = null;
    }
  }

  cancel() {
    this._controller?.abort('cancelled');
  }
}
