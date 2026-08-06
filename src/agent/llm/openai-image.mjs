export class OpenAIImageProvider {
  constructor({ baseUrl, model, apiKey, apiKeyError = '', headers = {} }) {
    const configuredUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.baseUrl = configuredUrl ? (configuredUrl.endsWith('/v1') ? configuredUrl : `${configuredUrl}/v1`) : '';
    this.model = model || '';
    this.apiKey = apiKey || '';
    this.apiKeyError = apiKeyError;
    this.headers = headers;
  }

  requestHeaders() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...this.headers };
  }

  async healthCheck({ timeoutMs = 5000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.requestHeaders(), signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generate({ prompt, size = 'auto', count = 1, quality = 'auto', images = [], timeoutMs = 120000, signal } = {}) {
    if (this.apiKeyError) throw Object.assign(new Error(this.apiKeyError), { code: 'IMAGE_API_KEY_ERROR' });
    if (!this.apiKey) throw Object.assign(new Error('请先在设置中填写 OpenAI Image API Key'), { code: 'IMAGE_API_KEY_MISSING' });
    if (!this.baseUrl) throw Object.assign(new Error('请先填写图像 API 地址'), { code: 'IMAGE_API_BASE_URL_MISSING' });
    if (!this.model) throw Object.assign(new Error('请先填写图像模型 ID'), { code: 'IMAGE_MODEL_MISSING' });
    if (!prompt?.trim()) throw Object.assign(new Error('图像提示词不能为空'), { code: 'IMAGE_PROMPT_EMPTY' });
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason || 'cancelled');
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const requestSignal = controller.signal;
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const normalizedCount = Math.min(10, Math.max(1, Number(count) || 1));
      const hasReferences = Array.isArray(images) && images.length > 0;
      const endpoint = hasReferences ? '/images/edits' : '/images/generations';
      let body;
      let headers = this.requestHeaders();
      if (hasReferences) {
        const form = new FormData();
        form.set('model', this.model);
        form.set('prompt', prompt);
        if (size !== 'default') form.set('size', size);
        if (quality !== 'default') form.set('quality', quality);
        form.set('n', String(normalizedCount));
        form.set('response_format', 'b64_json');
        for (const image of images) {
          const bytes = Buffer.from(image.base64, 'base64');
          form.append('image', new Blob([bytes], { type: image.mimeType || 'image/png' }), image.filename || 'reference.png');
        }
        body = form;
        headers = { Authorization: `Bearer ${this.apiKey}`, ...this.headers };
      } else {
        body = JSON.stringify({
          model: this.model,
          prompt,
          n: normalizedCount,
          response_format: 'b64_json',
          ...(size !== 'default' ? { size } : {}),
          ...(quality !== 'default' ? { quality } : {}),
        });
      }
       const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body,
         signal: requestSignal,
      });
      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`OpenAI Image API error (${response.status}): ${text.slice(0, 500)}`);
        error.code = response.status === 429 ? 'IMAGE_API_RATE_LIMITED' : response.status >= 500 ? 'IMAGE_API_SERVER_ERROR' : 'IMAGE_API_HTTP_ERROR';
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = (await response.json()).data || [];
       const resultImages = await Promise.all(data.map(async image => {
        if (image.b64_json) return { base64: image.b64_json, mimeType: 'image/png' };
        if (!image.url) return null;
         const downloaded = await fetch(image.url, { signal: requestSignal });
         if (!downloaded.ok) throw Object.assign(new Error(`无法下载图像结果 (${downloaded.status})`), { code: 'IMAGE_RESULT_DOWNLOAD_FAILED' });
         const bytes = Buffer.from(await downloaded.arrayBuffer());
        return { base64: bytes.toString('base64'), mimeType: downloaded.headers.get('content-type') || 'image/png' };
      }));
       const validImages = resultImages.filter(Boolean);
       if (validImages.length === 0) throw Object.assign(new Error('图像 API 未返回可保存的图片数据'), { code: 'IMAGE_RESULT_EMPTY' });
      return { images: validImages, revisedPrompt: data[0]?.revised_prompt || '' };
    } catch (error) {
       if (requestSignal.aborted) {
         const cancelled = requestSignal.reason === 'cancelled';
         throw Object.assign(new Error(cancelled ? '图像生成已取消' : `图像生成在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`), { code: cancelled ? 'IMAGE_REQUEST_CANCELLED' : 'IMAGE_API_TIMEOUT', retryable: !cancelled });
       }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
