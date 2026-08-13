import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
};

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ComfyUI URL must use http or https');
  return url.toString().replace(/\/+$/, '');
}

function queueContains(items, promptId) {
  return (items || []).some(item => item?.[1] === promptId || item?.[0] === promptId);
}

function abortError() {
  return Object.assign(new Error('Execution cancelled'), { name: 'AbortError' });
}

function hasOutputMedia(entry = {}) {
  return Object.values(entry.outputs || {}).some(outputs =>
    Object.values(outputs || {}).some(items =>
      Array.isArray(items) && items.some(item => item?.filename),
    ),
  );
}

// Cap on data URLs and /view payloads returned to the caller (and from there
// forwarded to the configured LLM provider).
const MAX_VIEW_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFER_BYTES = 16 * 1024 * 1024;
const VIEW_TYPES = new Set(['input', 'output', 'temp']);

// Validates an LLM-supplied {filename, subfolder, type} reference before it is
// forwarded to ComfyUI /view, so server-side traversal primitives cannot be
// reached from agent-controlled input.
function validateViewRef(image = {}) {
  const filename = String(image.filename || '');
  const subfolder = String(image.subfolder || '');
  const type = String(image.type || 'output');
  if (!filename || /[\\/]/.test(filename) || filename === '..' || filename.includes('..')) {
    throw new Error('Invalid ComfyUI image filename');
  }
  if (/[\u0000-\u001f\u007f]/.test(filename) || /[\u0000-\u001f\u007f]/.test(subfolder)) {
    throw new Error('Invalid ComfyUI image reference');
  }
  if (subfolder && (subfolder.startsWith('/') || subfolder.startsWith('\\') || subfolder.split(/[\\/]/).includes('..') || subfolder.includes(':'))) {
    throw new Error('Invalid ComfyUI image subfolder');
  }
  if (!VIEW_TYPES.has(type)) throw new Error('Invalid ComfyUI image type');
  return { filename, subfolder, type };
}

function viewParams(image = {}) {
  const ref = validateViewRef(image);
  const params = new URLSearchParams();
  params.set('filename', ref.filename);
  params.set('subfolder', ref.subfolder);
  params.set('type', ref.type);
  return params;
}

class NodeWebSocket {
  constructor(url) {
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.handshakeComplete = false;

    const target = new URL(url);
    const secure = target.protocol === 'wss:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const options = { host: target.hostname, port };
    const socket = secure
      ? createTlsConnection({ ...options, servername: target.hostname })
      : createConnection(options);
    this.socket = socket;
    socket.setTimeout(3000, () => this._fail(new Error('ComfyUI websocket timeout')));
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const key = randomBytes(16).toString('base64');
      socket.write([
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', chunk => this._receive(chunk));
    socket.on('error', error => this._fail(error));
    socket.on('close', () => this._emit('close', {}));
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  close() {
    this.socket?.end();
    this.socket?.destroy();
  }

  _emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  _fail(error) {
    if (!this.connected) this._emit('error', error);
    this.close();
  }

  _receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_WS_BUFFER_BYTES) {
      this._fail(new Error('ComfyUI websocket message exceeds the size limit'));
      return;
    }
    if (!this.handshakeComplete) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = this.buffer.subarray(0, headerEnd).toString();
      this.buffer = this.buffer.subarray(headerEnd + 4);
      if (!/^HTTP\/1\.1 101 /i.test(headers)) {
        this._fail(new Error('ComfyUI websocket handshake failed'));
        return;
      }
      this.handshakeComplete = true;
      this.connected = true;
      this.socket.setTimeout(0);
      this._emit('open', {});
    }

    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        if (this.buffer.readUInt32BE(2) > 0) {
          this._fail(new Error('ComfyUI websocket frame is too large'));
          return;
        }
        length = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payloadStart = offset + maskOffset;
      const payload = Buffer.from(this.buffer.subarray(payloadStart, payloadStart + length));
      this.buffer = this.buffer.subarray(payloadStart + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      const opcode = first & 0x0f;
      if (opcode === 0x1) this._emit('message', { data: payload.toString('utf8') });
      else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      }
    }
  }

  _sendFrame(opcode, payload) {
    const body = Buffer.from(payload || '');
    const key = randomBytes(4);
    let header;
    if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else throw new Error('ComfyUI websocket payload is too large');
    for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
    this.socket.write(Buffer.concat([header, key, body]));
  }
}

function createProgressWebSocket(url) {
  if (typeof globalThis.WebSocket === 'function') return new globalThis.WebSocket(url);
  return new NodeWebSocket(url);
}

function delay(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export { queueContains };

export class ComfyUIClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs || 600000;
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
  }

  setBaseUrl(value) {
    this.baseUrl = normalizeBaseUrl(value);
  }

  async request(path, opts = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await this._fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI error (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  async _fetch(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('ComfyUI request timed out')), this.requestTimeoutMs);
    let onAbort;
    if (opts.signal) {
      onAbort = () => controller.abort(opts.signal.reason);
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  async queuePrompt(prompt, clientId, signal) {
    return this.request('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt, client_id: clientId }),
      ...(signal ? { signal } : {}),
    });
  }

  async submit(prompt, clientId, options = {}) {
    try {
      const result = await this.queuePrompt(prompt, clientId, options.signal);
      if (!result?.prompt_id) {
        const error = new Error('ComfyUI prompt response missing prompt_id');
        error.failureType = 'submit_unknown';
        error.retryable = false;
        error.userMessage = 'ComfyUI 已提交状态未知，请检查任务队列后再决定是否重试';
        throw error;
      }
      return { promptId: result.prompt_id };
    } catch (error) {
      if (error?.failureType === 'submit_unknown' || /timed out|fetch failed|network|connection|econn|reset|unexpected end|json|parse/i.test(error?.message || '')) {
        error.failureType = 'submit_unknown';
        error.retryable = false;
        error.userMessage = 'ComfyUI 已提交状态未知，请检查任务队列后再决定是否重试';
      }
      throw error;
    }
  }

  async uploadMedia(kind, filename, data, options = {}) {
    const form = new FormData();
    const ext = filename.split('.').pop().toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    form.append('image', new Blob([data], { type: mime }), filename);
    if (options.overwrite) form.append('overwrite', 'true');
    if (options.type) form.append('type', options.type);
    if (options.originalRef) form.append('original_ref', JSON.stringify(options.originalRef));

    const endpoint = kind === 'mask' && options.originalRef ? '/upload/mask' : '/upload/image';
    const res = await this._fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      body: form,
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI upload error (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  async queueDelete(promptIds) {
    const ids = Array.isArray(promptIds) ? promptIds : [promptIds];
    if (ids.length === 0) return;
    await this.request('/queue', {
      method: 'POST',
      body: JSON.stringify({ delete: ids }),
    });
  }

  async interrupt(promptId) {
    await this.request('/interrupt', {
      method: 'POST',
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
    });
  }

  async queue(opts = {}) {
    return this.request('/queue', opts);
  }

  async history(promptId, opts = {}) {
    return this.request(`/history/${encodeURIComponent(promptId)}`, opts);
  }

  async historyRecent(limit = 1) {
    return this.request(`/history?max_items=${limit}`);
  }

  async inspectImage(image = {}) {
    const result = await this.inspectMedia(image);
    return {
      filename: result.filename,
      exists: result.exists,
      readable: result.readable,
      validFormat: result.readable && isImageBytes(result.bytes || new Uint8Array()),
    };
  }

  async inspectMedia(media = {}) {
    const params = viewParams(media);
    const res = await this._fetch(`${this.baseUrl}/view?${params.toString()}`);
    if (!res.ok) return { filename: media.filename, exists: false, readable: false, bytes: null };
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { filename: media.filename, exists: true, readable: bytes.length > 0, bytes };
  }

  async fetchImageBytes(image = {}) {
    const params = viewParams(image);
    const res = await this._fetch(`${this.baseUrl}/view?${params.toString()}`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  async modelList(folder, query = '') {
    const params = new URLSearchParams();
    if (folder) params.set('folder', folder);
    if (query) params.set('query', query);
    const search = params.toString() ? `?${params.toString()}` : '';
    const data = await this.request(`/experiment/models/${encodeURIComponent(folder || '')}${search}`);
    return Array.isArray(data) ? data : (data?.models || data?.files || []);
  }

  async imageDataUrl(image = {}) {
    try {
      if (image.path) {
        const stat = await stat(image.path).catch(() => null);
        if (!stat || stat.size > MAX_VIEW_BYTES) return null;
        const data = await readFile(image.path);
        const mime = MIME_TYPES[(image.path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
        return `data:${mime};base64,${data.toString('base64')}`;
      }
      const params = viewParams(image);
      const res = await this._fetch(`${this.baseUrl}/view?${params.toString()}`);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = MIME_TYPES[(image.filename || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch {
      return null;
    }
  }

  async objectInfo() {
    return this.request('/object_info');
  }

  async systemStats() {
    return this.request('/system_stats');
  }

  async waitForCompletion(promptId, pollMs = 1000, signal) {
    const start = Date.now();
    let missingSince = 0;
    for (;;) {
      try {
        // 取消竞态：手动取消时生成可能已完成（例如轮询间隔内到达 100%），
        // 成果不应被取消吞掉 —— 任何中止路径都先尝试从历史抢救成功条目。
        if (signal?.aborted) return this._salvageCompleted(promptId);
        if (Date.now() - start > this.timeoutMs) throw new Error('ComfyUI generation timeout');

        const requestOptions = signal ? { signal } : {};
        const queue = await this.queue(requestOptions);
        const running = queue.queue_running || [];
        const pending = queue.queue_pending || [];
        const stillQueued = queueContains(running, promptId) || queueContains(pending, promptId);

        if (!stillQueued) {
          const history = await this.history(promptId, requestOptions);
          if (history[promptId]) {
            const status = history[promptId].status;
            if (status?.completed && status.status_str && status.status_str !== 'success') {
              const lastMessage = status.messages?.at(-1)?.[1];
              throw new Error(lastMessage?.exception_message || `ComfyUI execution ${status.status_str}`);
            }
            return history[promptId];
          }
          if (!missingSince) missingSince = Date.now();
          if (Date.now() - missingSince > 15000) {
            throw new Error(`ComfyUI prompt disappeared before completion: ${promptId}`);
          }
          await delay(2000, signal);
          continue;
        }
        missingSince = 0;
        await delay(pollMs, signal);
      } catch (error) {
        if (signal?.aborted) return this._salvageCompleted(promptId);
        throw error;
      }
    }
  }

  async observe(promptId, pollMs = 1000, signal) {
    if (!promptId) throw new Error('ComfyUI promptId is required for observation');
    return this.waitForCompletion(promptId, pollMs, signal);
  }

  // 中止时做最后一次无信号历史检查：ComfyUI 侧已成功完成且有输出则按完成返回，
  // 否则按正常取消抛出 AbortError。
  async _salvageCompleted(promptId) {
    try {
      const history = await this.history(promptId);
      const entry = history?.[promptId];
      if (entry?.status?.status_str === 'success' && hasOutputMedia(entry)) return entry;
    } catch {}
    throw abortError();
  }

  async fetchResult(promptId, signal) {
    if (!promptId) throw new Error('ComfyUI promptId is required for result retrieval');
    const history = await this.history(promptId, signal ? { signal } : {});
    return history[promptId] || null;
  }

  openProgressSocket(clientId, prompt, onProgress, signal) {
    if (typeof onProgress !== 'function') return Promise.resolve(null);

    return new Promise(resolveSocket => {
      const socketUrl = `ws${this.baseUrl.startsWith('https') ? 's' : ''}://${new URL(this.baseUrl).host}/ws?clientId=${encodeURIComponent(clientId)}`;
      let socket;
      let promptId = '';
      try {
        socket = createProgressWebSocket(socketUrl);
      } catch {
        resolveSocket(null);
        return;
      }
      let settled = false;
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      };
      const settle = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveSocket(value);
      };
      timeout = setTimeout(() => {
        socket.close();
        settle(null);
      }, 10000);
      const workflowNodeCount = Object.keys(prompt || {}).length;
      const executedNodes = new Set();
      let currentNodeId = '';
      let currentNodePercent = null;

      const emitExecutionProgress = (data = {}) => {
        const nodeId = data.nodeId ? String(data.nodeId) : '';
        const nodePercent = Number.isFinite(data.nodePercent) ? data.nodePercent : null;
        const completedNodes = executedNodes.size;
        const overallPercent = workflowNodeCount > 0
          ? Math.round(((completedNodes + (nodePercent === null ? 0 : nodePercent / 100)) / workflowNodeCount) * 100)
          : null;
        onProgress({
          ...data,
          ...(nodePercent === null ? {} : { nodePercent }),
          ...(overallPercent === null ? {} : { percent: Math.max(0, Math.min(100, overallPercent)), overallPercent: Math.max(0, Math.min(100, overallPercent)) }),
          percentScope: overallPercent === null ? 'node' : 'overall',
          workflowNodeCount,
          completedNodeCount: completedNodes,
        });
      };

      socket.setPromptId = value => { promptId = value || ''; };
      const abort = () => {
        socket.close();
        settle(null);
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });

      socket.addEventListener('open', () => {
        settle(socket);
      }, { once: true });
      socket.addEventListener('error', () => {
        settle(null);
      }, { once: true });
      socket.addEventListener('close', cleanup, { once: true });
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          const data = message.data || {};
          const messagePromptId = message.prompt_id || data.prompt_id || '';
          if (promptId && messagePromptId && messagePromptId !== promptId) return;
          const nodeId = data.node != null ? String(data.node) : '';
          const nodeType = nodeId ? prompt[nodeId]?.class_type || '' : '';

          if (message.type === 'execution_start') {
            executedNodes.clear();
            currentNodeId = '';
            currentNodePercent = null;
            emitExecutionProgress({ stage: 'executing', message: '工作流开始执行', percent: 0, overallPercent: 0, percentScope: 'overall' });
          } else if (message.type === 'executing' && nodeId) {
            if (currentNodeId && currentNodeId !== nodeId) executedNodes.add(currentNodeId);
            currentNodeId = nodeId;
            currentNodePercent = 0;
            emitExecutionProgress({ stage: 'node', nodeId, nodeType, nodePercent: 0, message: `正在执行 ${nodeType || `节点 ${nodeId}`}` });
          } else if (message.type === 'progress' && Number.isFinite(data.value) && Number.isFinite(data.max)) {
            currentNodeId = nodeId || currentNodeId;
            currentNodePercent = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0;
            emitExecutionProgress({
               stage: 'sampling',
               nodeId,
               nodeType,
               value: data.value,
               max: data.max,
               nodePercent: currentNodePercent,
               message: `${nodeType || `节点 ${nodeId}`} ${data.value}/${data.max}`,
             });
          } else if (message.type === 'execution_error') {
            emitExecutionProgress({ stage: 'error', nodeId, nodeType, message: data.exception_message || '工作流执行失败' });
          } else if (message.type === 'execution_interrupted') {
            emitExecutionProgress({ stage: 'cancelled', message: '工作流已取消' });
          }
        } catch {}
      });
    });
  }
}

function isImageBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}
