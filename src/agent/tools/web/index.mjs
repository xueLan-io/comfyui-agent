import { lookup } from 'node:dns/promises';
import net, { isIP } from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BING_ENDPOINT = 'https://cn.bing.com/search';
const BAIDU_ENDPOINT = 'https://www.baidu.com/s';
const BAIDU_AI_SEARCH_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_summary';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 300000;
const PROXY_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 12000;
const MAX_RESULTS = 10;
const MAX_CACHE_ENTRIES = 64;
const TRUST_LEVELS = ['official', 'verified', 'community', 'unknown'];

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(value = '') {
  return decodeEntities(String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim();
}

function normalizedDomains(value) {
  return (Array.isArray(value) ? value : []).map(item => String(item).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '')).filter(Boolean);
}

function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function allowedDomain(url, domains) {
  if (!domains || domains.length === 0) return true;
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return domains.some(domain => domainMatches(hostname, domain));
}

export function classifySource(rawUrl, policy = {}) {
  let hostname = '';
  try { hostname = new URL(rawUrl).hostname.toLowerCase(); } catch { return 'unknown'; }
  const groups = [
    ['official', normalizedDomains(policy.officialDomains)],
    ['verified', normalizedDomains(policy.verifiedDomains)],
    ['community', normalizedDomains(policy.communityDomains)],
  ];
  for (const [level, domains] of groups) {
    if (domains.some(domain => domainMatches(hostname, domain))) return level;
  }
  return 'unknown';
}

function sourcePolicy(input = {}) {
  return {
    allowedDomains: normalizedDomains(input.allowedDomains),
    officialDomains: normalizedDomains(input.officialDomains),
    verifiedDomains: normalizedDomains(input.verifiedDomains),
    communityDomains: normalizedDomains(input.communityDomains),
  };
}

function privateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0) || (a === 192 && b === 168)
    || (a === 198 && b >= 18 && b <= 19) || a >= 224;
}

function privateAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) return privateIPv4(normalized);
  if (isIP(normalized) !== 6) return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIPv4(mapped[1]);
  if (normalized.includes(':')) {
    const [left, right = ''] = normalized.split('::');
    const groups = [
      ...(left ? left.split(':') : []),
      ...Array(8 - (left ? left.split(':').length : 0) - (right ? right.split(':').length : 0)).fill('0'),
      ...(right ? right.split(':') : []),
    ];
    if (groups.length === 8 && groups.slice(0, 5).every(group => parseInt(group || '0', 16) === 0)
      && parseInt(groups[5], 16) === 0xffff) {
      const high = parseInt(groups[6], 16);
      const low = parseInt(groups[7], 16);
      return privateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb');
}

async function validateAndResolve(rawUrl, lookupImpl = lookup) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname === '0.0.0.0' || hostname === '::1' || privateAddress(hostname)) {
    throw new Error('Local and private network URLs are not allowed');
  }
  if (!isIP(hostname)) {
    const addresses = await lookupImpl(hostname, { all: true });
    if (addresses.some(item => privateAddress(item.address))) throw new Error('The URL resolves to a local or private network');
    const address = addresses.find(item => !privateAddress(item.address));
    if (!address) throw new Error('The URL has no public address');
    return { url, address: address.address, family: address.family };
  }
  return { url, address: hostname, family: isIP(hostname) };
}

async function validateRemoteUrl(rawUrl, lookupImpl = lookup) {
  return (await validateAndResolve(rawUrl, lookupImpl)).url;
}

async function readResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Response is too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeResponse(bytes, response.headers);
}

function decodeResponse(bytes, headers) {
  const encoding = String(headers?.get?.('content-encoding') || '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean).pop();
  let decoded = Buffer.from(bytes);
  if (encoding === 'gzip') decoded = gunzipSync(decoded);
  else if (encoding === 'deflate') decoded = inflateSync(decoded);
  else if (encoding === 'br') decoded = brotliDecompressSync(decoded);
  if (decoded.byteLength > MAX_RESPONSE_BYTES) throw new Error('Response is too large');
  const charset = String(headers?.get?.('content-type') || '').match(/charset\s*=\s*([^;\s]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(decoded); } catch { return new TextDecoder().decode(decoded); }
}

async function fetchText(fetchImpl, rawUrl, signal, redirects = 0, lookupImpl = lookup, policy = {}, proxy = null) {
  if (!allowedDomain(rawUrl, policy.allowedDomains)) throw new Error('The URL domain is not allowed');
  const resolved = await validateAndResolve(rawUrl, lookupImpl);
  const { url } = resolved;
  const headers = {
    accept: 'text/html, application/xhtml+xml, application/json, text/plain;q=0.9, */*;q=0.1',
    'user-agent': 'ComfyMuse/0.2',
  };
  const response = fetchImpl === globalThis.fetch
    ? await requestPinned(url, resolved, signal, headers, proxy)
    : await fetchImpl(url, { method: 'GET', redirect: 'manual', signal, headers });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 3) throw new Error('Too many redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response has no location');
    await response.text().catch(() => {});
    return fetchText(fetchImpl, new URL(location, url).toString(), signal, redirects + 1, lookupImpl, policy, proxy);
  }
  if (!response.ok) {
    await response.text().catch(() => {});
    throw new Error(`Web request failed with HTTP ${response.status}`);
  }
  return { url: url.toString(), contentType: response.headers.get('content-type') || '', text: await readResponse(response) };
}

function requestPinned(url, resolved, signal, headers, proxy = null, method = 'GET', body = null) {
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const secure = url.protocol === 'https:';
  const options = {
    method,
    headers,
    signal,
    host: url.hostname,
    port,
    path: `${url.pathname || '/'}${url.search || ''}`,
    servername: url.hostname,
  };
  return new Promise((resolve, reject) => {
    let request;
    const onError = error => reject(error);
    if (proxy) {
      options.createConnection = (_connectionOptions, callback) => {
        proxyTunnel(proxy, url.hostname, port, signal, (error, socket) => {
          if (error) return callback(error);
          callback(null, secure ? tls.connect({ socket, servername: url.hostname }) : socket);
        });
      };
    } else {
      options.lookup = (_hostname, lookupOptions, callback) => {
        const address = { address: resolved.address, family: resolved.family };
        if (lookupOptions?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      };
    }
    request = (secure ? https.request : http.request)(options, response => resolve(wrapResponse(response)));
    request.on('error', onError);
    request.end(body);
  });
}

function parseSearchResults(html, limit, policy = {}) {
  const anchors = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attrs = match[1];
    if (!/\bresult__a\b/i.test(attrs)) continue;
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const title = cleanText(match[2]);
    if (!href || !title) continue;
    let url;
    try {
      url = new URL(href, SEARCH_ENDPOINT);
      const redirected = url.searchParams.get('uddg');
      if (redirected) url = new URL(redirected);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (!allowedDomain(url, policy.allowedDomains)) continue;
    anchors.push({ title, url: url.toString(), trustLevel: classifySource(url, policy) });
    if (anchors.length >= limit) break;
  }

  const snippets = [...html.matchAll(/<[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)]
    .map(match => cleanText(match[1]));
  return anchors.map((item, index) => ({ ...item, snippet: snippets[index] || '' }));
}

function decodeRedirectUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const encoded = url.searchParams.get('u');
    if (!encoded) return rawUrl;
    let decoded;
    try {
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
      decoded = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8');
    } catch {
      return rawUrl;
    }
    return /^https?:\/\//i.test(decoded) ? decoded : rawUrl;
  } catch {
    return rawUrl;
  }
}

function parseBingResults(html, limit, policy = {}) {
  const results = [];
  const blocks = html.match(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const href = block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const title = cleanText(block.match(/<h2\b[^>]*>[\s\S]*?<\/a>\s*<\/h2>/i)?.[0] || '');
    if (!title) continue;
    let url;
    try {
      url = new URL(decodeRedirectUrl(href), BING_ENDPOINT);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (!allowedDomain(url, policy.allowedDomains)) continue;
    const snippet = cleanText(block.match(/<p\b[^>]*class=["'][^"']*b_lineclamp[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
    results.push({ title, url: url.toString(), trustLevel: classifySource(url, policy), snippet });
    if (results.length >= limit) break;
  }
  return results;
}

function parseBaiduResults(html, limit, policy = {}) {
  const results = [];
  const anchorPattern = /<h3\b[^>]*class=["'][^"']*t[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const title = cleanText(match[2]);
    if (!match[1] || !title) continue;
    let url;
    try {
      url = new URL(match[1].replace(/&amp;/g, '&'), BAIDU_ENDPOINT);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (!allowedDomain(url, policy.allowedDomains)) continue;
    const snippet = cleanText(html.slice(match.index, match.index + match[0].length + 600).match(/<[^>]*class=["'][^"']*(?:c-abstract|content-right_)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '');
    results.push({ title, url: url.toString(), trustLevel: classifySource(url, policy), snippet });
    if (results.length >= limit) break;
  }
  return results;
}

function parseBaiduApiResults(payload, limit, policy = {}) {
  const references = Array.isArray(payload?.references) ? payload.references : [];
  const results = [];
  const seen = new Set();
  for (const reference of references) {
    const rawUrl = String(reference?.url || '').trim();
    if (!rawUrl || !allowedDomain(rawUrl, policy.allowedDomains)) continue;
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.toString())) continue;
    seen.add(url.toString());
    results.push({
      title: cleanText(reference.title || reference.website || rawUrl).slice(0, 300),
      url: url.toString(),
      snippet: cleanText(reference.snippet || reference.content || '').slice(0, 1200),
      trustLevel: classifySource(url, policy),
    });
    if (results.length >= limit) break;
  }
  return {
    answer: cleanText(payload?.choices?.[0]?.message?.content || '').slice(0, MAX_PAGE_CHARS),
    results,
  };
}

const SEARCH_PROVIDERS = {
  duckduckgo: { buildUrl: query => `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`, parse: parseSearchResults },
  bing: { buildUrl: query => `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&count=20`, parse: parseBingResults },
  baidu: { buildUrl: query => `${BAIDU_ENDPOINT}?wd=${encodeURIComponent(query)}&rn=20`, parse: parseBaiduResults },
};
const DEFAULT_PROVIDERS = ['bing', 'duckduckgo', 'baidu'];
const NETWORK_ERROR = /(fetch failed|econnrefused|econnreset|etimedout|ehostunreach|enotfound|socket|timed out|timeout|connection|network|tunneling|proxy)/i;

function resolveSearchProviders(input, query = '') {
  let known;
  if (Array.isArray(input) && input.length) {
    known = input.map(item => String(item).trim().toLowerCase()).filter(name => SEARCH_PROVIDERS[name]);
  }
  if (!known || known.length === 0) known = [...DEFAULT_PROVIDERS];
  const isCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(query));
  const rank = isCjk
    ? { baidu: 0, bing: 1, duckduckgo: 2 }
    : { bing: 0, duckduckgo: 1, baidu: 2 };
  return [...new Set(known)].sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9));
}

function parsePage(url, contentType, html) {
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const description = cleanText(html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)?.[1] || '');
  const content = cleanText(html).slice(0, MAX_PAGE_CHARS);
  return {
    url,
    title: title.slice(0, 300),
    description: description.slice(0, 600),
    content,
    contentType,
  };
}

function parseProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (!url.hostname || !port) return null;
  return { host: url.hostname, port, secure: url.protocol === 'https:' };
}

let cachedSystemProxy;
function readSystemProxy() {
  if (cachedSystemProxy !== undefined) return cachedSystemProxy;
  cachedSystemProxy = { enabled: false, proxy: null };
  if (process.platform !== 'win32') return cachedSystemProxy;
  let enabled = false;
  let value = '';
  try {
    const enable = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    enabled = /0x1/i.test(enable);
  } catch {}
  try {
    const server = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    value = server.match(/ProxyServer\s+REG_\w+\s+(.+)/i)?.[1]?.trim() || '';
  } catch {}
  const schemeValue = value.match(/(?:^|;)\s*https?=(?:https?:\/\/)?([^;]+)/i)?.[1];
  cachedSystemProxy = { enabled, proxy: parseProxyUrl(schemeValue || value) };
  return cachedSystemProxy;
}

function windowsSystemProxy() {
  const info = readSystemProxy();
  return info.enabled ? info.proxy : null;
}

function systemProxyCandidate() {
  const info = readSystemProxy();
  return info.enabled ? null : info.proxy;
}

function resolveProxy(inputProxyUrl) {
  const explicit = parseProxyUrl(inputProxyUrl);
  if (explicit) return explicit;
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
    const parsed = process.env[name] ? parseProxyUrl(process.env[name]) : null;
    if (parsed) return parsed;
  }
  return windowsSystemProxy();
}

function proxyTunnel(proxy, hostname, port, signal, callback) {
  let buffer = '';
  let settled = false;
  const socket = proxy.secure
    ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
    : net.connect({ host: proxy.host, port: proxy.port });
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.off('data', onData);
    socket.off('error', onError);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (error) socket.destroy();
    callback(error, value);
  };
  const onError = error => finish(error);
  const onAbort = () => finish(new Error('Proxy connection was aborted'));
  const onData = chunk => {
    buffer += chunk.toString('latin1');
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const statusLine = buffer.split('\r\n')[0];
    if (/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) finish(null, socket);
    else finish(new Error(`Proxy refused the connection: ${statusLine}`));
  };
  const timer = setTimeout(() => finish(new Error('Proxy connection timed out')), PROXY_TIMEOUT_MS);
  socket.on('error', onError);
  socket.on('data', onData);
  socket.on('connect', () => socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`));
  if (signal) {
    if (signal.aborted) return finish(new Error('Proxy connection was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  }
}

function wrapResponse(nodeResponse) {
  return {
    ok: nodeResponse.statusCode >= 200 && nodeResponse.statusCode < 300,
    status: nodeResponse.statusCode,
    headers: new Headers(nodeResponse.headers),
    body: null,
    async text() {
      const chunks = [];
      let size = 0;
      for await (const chunk of nodeResponse) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Response is too large');
        chunks.push(chunk);
      }
      return decodeResponse(Buffer.concat(chunks), new Headers(nodeResponse.headers));
    },
  };
}

function createAbortSignal(timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Web request timed out')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function fetchBaiduApi(fetchImpl, lookupImpl, signal, proxy, apiKey, query, maxResults, policy) {
  const payload = {
    messages: [{ role: 'user', content: query }],
    stream: false,
    resource_type_filter: [
      { type: 'web', top_k: Math.min(Math.max(maxResults, 1), 50) },
      { type: 'video', top_k: 0 },
      { type: 'image', top_k: 0 },
    ],
  };
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'ComfyMuse/0.2',
    'X-Appbuilder-Authorization': `Bearer ${apiKey}`,
  };
  const resolved = await validateAndResolve(BAIDU_AI_SEARCH_ENDPOINT, lookupImpl);
  const response = fetchImpl === globalThis.fetch
    ? await requestPinned(resolved.url, resolved, signal, headers, proxy, 'POST', JSON.stringify(payload))
    : await fetchImpl(BAIDU_AI_SEARCH_ENDPOINT, { method: 'POST', redirect: 'manual', signal, headers, body: JSON.stringify(payload) });
  const text = await readResponse(response);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Baidu AI Search returned invalid JSON'); }
  if (!response.ok || body.code || body.error_code) {
    throw new Error(`Baidu AI Search failed${body.message ? `: ${body.message}` : ` with HTTP ${response.status}`}`);
  }
  return parseBaiduApiResults(body, Math.min(maxResults, MAX_RESULTS), policy);
}

export function createWebTool(fetchImpl = globalThis.fetch, lookupImpl = lookup, options = {}) {
  const cache = new Map();
  const defaultCacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;

  function readCache(key, ttlMs) {
    const item = cache.get(key);
    if (!item || Date.now() - item.createdAt > ttlMs) {
      if (item) cache.delete(key);
      return null;
    }
    return { ...item.value, cacheHit: true };
  }

  function writeCache(key, value) {
    cache.set(key, { createdAt: Date.now(), value });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  return {
    name: 'web',
    description: 'Search public web pages or open a public URL for user-requested reference research.',
    category: 'web',
    tags: ['web', 'search', 'character', 'reference'],
    timeout_ms: DEFAULT_TIMEOUT_MS,
    side_effects: ['network_request'],
    requires_confirmation: false,
    idempotent: true,
    retry: { mode: 'limited', max_attempts: 1 },
    output_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        query: { type: 'string' },
        answer: { type: 'string' },
        results: { type: 'array' },
        page: { type: 'object' },
        error: { type: 'string' },
      },
    },
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'open'] },
        query: { type: 'string' },
        url: { type: 'string' },
        maxResults: { type: 'number', minimum: 1, maximum: MAX_RESULTS },
        timeoutMs: { type: 'number', minimum: 1000, maximum: DEFAULT_TIMEOUT_MS },
        maxOpenPages: { type: 'number', minimum: 0, maximum: 10 },
        allowNetwork: { type: 'boolean' },
        cacheTtlMs: { type: 'number', minimum: 0, maximum: 86400000 },
        allowedDomains: { type: 'array', items: { type: 'string' } },
        sourcePolicy: { type: 'object' },
        providers: { type: 'array', items: { type: 'string', enum: Object.keys(SEARCH_PROVIDERS) }, description: 'Fallback search providers to try in order' },
        proxyUrl: { type: 'string', description: 'HTTP proxy for outbound requests, e.g. http://127.0.0.1:7897' },
        baiduApiKey: { type: 'string', description: 'Optional Baidu AI Search API key' },
      },
      required: ['action'],
    },

    async execute({ action, query = '', url = '', maxResults = MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS, allowNetwork = true, cacheTtlMs = defaultCacheTtlMs, allowedDomains = [], sourcePolicy: inputPolicy = {}, providers = [], proxyUrl = '', baiduApiKey = '', signal }) {
      if (allowNetwork === false) return { action, error: '未进行在线检索', researchStatus: 'disabled' };
      if (typeof fetchImpl !== 'function') return { action, error: 'Web fetch is unavailable in this runtime' };
      const policy = sourcePolicy({ ...inputPolicy, allowedDomains: inputPolicy.allowedDomains || allowedDomains });
      const ttlMs = Math.max(0, Math.min(Number(cacheTtlMs) || 0, 86400000));
      const proxy = options.resolveProxy ? options.resolveProxy(proxyUrl) : resolveProxy(proxyUrl);
      const fallbackProxy = fetchImpl === globalThis.fetch && !proxy
        ? (options.systemProxyCandidate || systemProxyCandidate)()
        : null;
      const searchProviders = resolveSearchProviders(providers, query);
      const key = JSON.stringify({
        action, query: String(query).trim(), url: String(url).trim(), maxResults, timeoutMs, policy, searchProviders,
        proxy: proxy ? `${proxy.host}:${proxy.port}` : null,
        fallbackProxy: fallbackProxy ? `${fallbackProxy.host}:${fallbackProxy.port}` : null,
        baiduApi: Boolean(baiduApiKey),
      });
      if (ttlMs > 0) {
        const cached = readCache(key, ttlMs);
        if (cached) return cached;
      }
      const request = createAbortSignal(Math.min(timeoutMs, DEFAULT_TIMEOUT_MS), signal);
      const startedAt = Date.now();
      // 每个 provider 独立计时（上限 4s 且不超过总预算）：
      // 单个卡死的源（如被墙的 duckduckgo）超时后跳过，已合并的结果不会丢失
      const providerTimeoutMs = () => Math.max(1000, Math.min(4000, Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) - (Date.now() - startedAt)));
      const fetchForProvider = async (target, targetPolicy) => {
        const perRequest = createAbortSignal(providerTimeoutMs(), request.signal);
        try {
          return await fetchText(fetchImpl, target, perRequest.signal, 0, lookupImpl, targetPolicy, proxy);
        } catch (error) {
          if (error.name === 'AbortError') {
            if (request.signal.aborted) throw error;
            throw new Error('Provider request timed out');
          }
          if (!fallbackProxy || !NETWORK_ERROR.test(error?.message || '')) throw error;
          return fetchText(fetchImpl, target, perRequest.signal, 0, lookupImpl, targetPolicy, fallbackProxy);
        } finally {
          perRequest.cleanup();
        }
      };
      try {
        if (action === 'search') {
          const trimmed = String(query).trim().slice(0, 300);
          if (!trimmed) return { action, error: 'Search query is empty' };
          const failures = [];
          if (String(baiduApiKey).trim()) {
            try {
              let apiResult;
              const apiRequest = createAbortSignal(providerTimeoutMs(), request.signal);
              try {
                apiResult = await fetchBaiduApi(fetchImpl, lookupImpl, apiRequest.signal, proxy, String(baiduApiKey).trim(), trimmed, maxResults, policy);
              } catch (error) {
                if (error.name === 'AbortError') {
                  if (request.signal.aborted) throw error;
                  throw new Error('Baidu AI Search timed out');
                }
                if (!fallbackProxy || !NETWORK_ERROR.test(error?.message || '')) throw error;
                apiResult = await fetchBaiduApi(fetchImpl, lookupImpl, apiRequest.signal, fallbackProxy, String(baiduApiKey).trim(), trimmed, maxResults, policy);
              } finally {
                apiRequest.cleanup();
              }
              if (apiResult.results.length > 0 || apiResult.answer) {
                const result = { action, query: trimmed, provider: 'baidu-api', answer: apiResult.answer, results: apiResult.results };
                if (ttlMs > 0) writeCache(key, result);
                return result;
              }
              failures.push('baidu-api: no results returned');
            } catch (error) {
              if (error.name === 'AbortError') return { action, error: 'Web request timed out or was cancelled' };
              failures.push(`baidu-api: ${error.message}`);
            }
          }
          const merged = [];
          const seen = new Set();
          const contributors = [];
          for (const name of searchProviders) {
            const spec = SEARCH_PROVIDERS[name];
            if (!spec) continue;
            try {
              const endpoint = spec.buildUrl(trimmed);
              const response = await fetchForProvider(endpoint, {});
              const results = spec.parse(response.text, Math.min(maxResults, MAX_RESULTS), policy);
              if (results.length > 0) contributors.push(name);
              for (const item of results) {
                const key = item.url.split('#')[0];
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(item);
              }
            } catch (error) {
              if (error.name === 'AbortError') return { action, error: 'Web request timed out or was cancelled' };
              failures.push(`${name}: ${error.message}`);
            }
          }
          if (merged.length === 0) {
            return { action, query: trimmed, error: failures.length ? `All search providers failed (${failures.join('; ')})` : 'No search providers configured', researchStatus: 'search_failed' };
          }
          const result = { action, query: trimmed, provider: contributors[0] || '', results: merged.slice(0, maxResults) };
          if (ttlMs > 0) writeCache(key, result);
          return result;
        }
        if (action === 'open') {
          if (!String(url).trim()) return { action, error: 'URL is empty' };
          if (!allowedDomain(url, policy.allowedDomains)) return { action, error: 'The URL domain is not allowed' };
          const response = await fetchForProvider(url, policy);
          const page = { ...parsePage(response.url, response.contentType, response.text), trustLevel: classifySource(response.url, policy) };
          const result = { action, page };
          if (ttlMs > 0) writeCache(key, result);
          return result;
        }
        return { action, error: `Unknown web action: ${action}` };
      } catch (error) {
        return { action, error: error.name === 'AbortError' ? 'Web request timed out or was cancelled' : error.message };
      } finally {
        request.cleanup();
      }
    },
  };
}

export const WebTool = createWebTool();
export const SEARCH_PROVIDER_NAMES = Object.keys(SEARCH_PROVIDERS);
export { cleanText, parsePage, parseSearchResults, parseBingResults, parseBaiduResults, privateAddress, validateRemoteUrl, resolveProxy, resolveSearchProviders, systemProxyCandidate };

export async function openResultPages(webTool, results, settings = {}) {
  const items = Array.isArray(results) ? results.slice(0, Math.max(Number(settings.maxOpenPages) || 0, 0)) : [];
  const pages = [];
  for (let index = 0; index < items.length; index++) {
    pages.push(await webTool.execute({
      action: 'open',
      url: items[index].url,
      timeoutMs: settings.timeoutMs,
      allowNetwork: settings.allowNetwork,
      cacheTtlMs: settings.cacheTtlMs,
      proxyUrl: settings.proxyUrl,
      baiduApiKey: settings.baiduApiKey,
      allowedDomains: settings.allowedDomains,
      sourcePolicy: settings,
    }));
    if (index < items.length - 1) await new Promise(resolve => setTimeout(resolve, 200));
  }
  return pages;
}
