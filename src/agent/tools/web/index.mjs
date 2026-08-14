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
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 300000;
const PROXY_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 12000;
const MAX_RESULTS = 10;
const MAX_CACHE_ENTRIES = 64;
const TRUST_LEVELS = ['official', 'verified', 'community', 'unknown'];
// 某来源失败后短期内不再重试（秒级冷却），避免每次搜索都撞墙拖慢整体
const DEFAULT_FAILURE_COOLDOWN_MS = 30000;
// 系统代理缓存有效期：改代理后最多延迟这么久生效
const SYSTEM_PROXY_CACHE_TTL_MS = 60000;
// 常见两段式公共后缀（CC 二级域等），用于精确计算"可注册域"（eTLD+1）
const PUBLIC_SUFFIX_2 = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'mil.cn', 'ac.cn',
  'com.hk', 'com.tw', 'com.mo', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.sg', 'com.my', 'com.ph', 'co.in', 'net.in', 'org.in',
  'com.br', 'com.mx', 'com.ar', 'co.kr', 'or.kr', 'ne.kr', 're.kr',
  'com.tr', 'co.id', 'or.id', 'web.id', 'com.vn', 'com.th', 'co.th',
  'com.sa', 'co.za', 'com.eg', 'com.ng', 'com.pk', 'com.bd', 'com.np',
  'com.lk', 'co.nz', 'net.nz', 'org.nz', 'com.pe', 'com.co', 'com.ec',
  'com.uy', 'com.py', 'com.bo', 'com.ve', 'com.ua', 'com.ru', 'co.il',
  'org.il', 'com.gr', 'com.pt', 'com.es', 'com.it', 'com.fr', 'com.de',
  'com.pl', 'com.se', 'com.no', 'com.fi', 'com.dk', 'com.hr', 'com.si',
  'com.sk', 'com.cz', 'com.hu', 'com.ro', 'com.bg', 'com.rs',
  'co.ke', 'co.tz', 'co.ug', 'co.zw', 'com.gh', 'com.cm', 'com.ci',
  'com.sn', 'com.ml', 'com.bf', 'com.ne', 'com.td', 'com.cg', 'com.ga',
  'com.gn', 'com.gw', 'com.sl', 'com.lr', 'com.mr', 'com.mg', 'com.km',
  'com.sc', 'com.mu', 'com.et', 'com.dj', 'com.so', 'com.er', 'com.ly',
  'com.tn', 'com.dz', 'com.ma', 'com.ye', 'com.iq', 'com.sy', 'com.lb',
  'com.jo', 'com.kw', 'com.qa', 'com.bh', 'com.om', 'com.ae', 'com.sa',
]);

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

// 整块剔除页面噪音元素（导航/页脚/侧栏/广告/评论区等），只保留正文文本。
// 用栈式扫描正确处理嵌套：进入噪音元素后其内部文本全部丢弃，直到匹配的闭合标签。
const NOISE_ELEMENTS = new Set(['nav', 'header', 'footer', 'aside', 'form', 'iframe', 'noscript', 'template', 'svg', 'style', 'script']);
const NOISE_CLASS_PATTERN = /\b(?:nav|menu|sidebar|footer|header|banner|advert|ads?|comment|cookie|popup|modal|social|share|breadcrumb|pagination|related|recommend|widget|toolbar|bottom)\b/i;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function stripNoiseBlocks(html) {
  const kept = [];
  const stack = [];
  let inNoise = 0;
  let textStart = 0;
  let i = 0;
  const n = String(html).length;
  while (i < n) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1) break;
      if (inNoise === 0 && textStart < i) kept.push(html.slice(textStart, i));
      i = end + 3;
      textStart = i;
      continue;
    }
    if (html[i] !== '<') { i += 1; continue; }
    let j = i + 1;
    const closing = html[j] === '/';
    if (closing) j += 1;
    const nameStart = j;
    while (j < n && /[a-zA-Z0-9-]/.test(html[j])) j += 1;
    const name = html.slice(nameStart, j).toLowerCase();
    if (!name || !/[a-zA-Z]/.test(name)) { i += 1; continue; }
    let quote;
    let tagEnd = -1;
    for (let k = j; k < n; k += 1) {
      const c = html[k];
      if (quote !== undefined) { if (c === quote) quote = undefined; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') { tagEnd = k; break; }
    }
    if (tagEnd === -1) break;
    // 进入标签前保留前面的正文（噪音内不保留）
    if (inNoise === 0 && textStart < i) kept.push(html.slice(textStart, i));
    const tagText = html.slice(i, tagEnd + 1);
    const isVoid = VOID_TAGS.has(name) || /\/\s*>$/.test(tagText);
    if (closing) {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) {
          if (stack[k].noise) inNoise -= 1;
          stack.length = k;
          break;
        }
      }
    } else if (!isVoid) {
      const noise = NOISE_ELEMENTS.has(name) || NOISE_CLASS_PATTERN.test(tagText);
      if (noise) inNoise += 1;
      stack.push({ name, noise });
    }
    i = tagEnd + 1;
    textStart = i;
  }
  if (inNoise === 0) kept.push(html.slice(textStart));
  // 块间用空格分隔，避免相邻正文（如标题与段落）粘连；cleanText 会归一空白
  return kept.join(' ');
}

function normalizedDomains(value) {
  return (Array.isArray(value) ? value : []).map(item => String(item).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '')).filter(Boolean);
}

/**
* 判断一个配置域名本身是否"可注册域"级别（eTLD+1）。
* 可注册域允许匹配其任意子域；比可注册域更深的配置（如 cn.bing.com）
* 只精确匹配自身，防止 evil.cn.bing.com 之类子域被白名单误放行。
*/
function isRegistrableDomain(domain) {
  const labels = domain.split('.');
  if (labels.length <= 1) return true;
  const lastTwo = labels.slice(-2).join('.');
  if (PUBLIC_SUFFIX_2.has(lastTwo)) {
    // 两段式公共后缀：可注册域 = 后缀前再加一段（如 example.com.cn）
    return labels.length === 3;
  }
  // 普通 TLD：可注册域就是最后两段
  return labels.length === 2;
}

function domainMatches(hostname, domain) {
  if (hostname === domain) return true;
  if (!hostname.endsWith(`.${domain}`)) return false;
  return isRegistrableDomain(domain);
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
  // 先去噪（导航/页脚/广告等整块剔除）再转文本，正文占比更高、token 更省
  const content = cleanText(stripNoiseBlocks(html)).slice(0, MAX_PAGE_CHARS);
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

// Only loopback proxies may be used; a remote proxy (steerable by an attacker
// who controls the LLM output) would observe every fetch target and, for plain
// HTTP targets, page content.
function isLoopbackProxy(value) {
  const parsed = parseProxyUrl(value);
  if (!parsed) return false;
  const host = String(parsed.host || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

let cachedSystemProxy;
let cachedSystemProxyAt = 0;
function readSystemProxy() {
  if (cachedSystemProxy !== undefined && Date.now() - cachedSystemProxyAt < SYSTEM_PROXY_CACHE_TTL_MS) return cachedSystemProxy;
  cachedSystemProxy = { enabled: false, proxy: null };
  cachedSystemProxyAt = Date.now();
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
  cachedSystemProxyAt = Date.now();
  return cachedSystemProxy;
}

// 手动清空系统代理缓存（改代理后调用立即生效，测试也用它隔离）
export function clearSystemProxyCache() {
  cachedSystemProxy = undefined;
  cachedSystemProxyAt = 0;
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

// --- 通用搜索 API（Tavily / SearXNG） ---
// 与 baidu-api 同级：可信配置提供 key/端点，模型无法控制，SSRF 风险面小。
// Tavily 是固定公网端点，走完整 DNS 钉扎校验；SearXNG 允许自托管回环地址（受信配置）。

async function validateApiUrl(rawUrl, { allowLocal = false } = {}, lookupImpl = lookup) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  if (allowLocal && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname) && privateAddress(url.hostname))) {
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname, family: isIP(url.hostname) }]
      : await lookupImpl(url.hostname, { all: true });
    if (addresses.length === 0 || addresses.some(item => !privateAddress(item.address))) {
      throw new Error('The local Search API must resolve to a loopback or private address');
    }
    const address = addresses[0];
    return { url, address: address.address, family: address.family || isIP(address.address) };
  }
  return validateAndResolve(rawUrl, lookupImpl);
}

async function fetchJsonApi(fetchImpl, lookupImpl, signal, proxy, { url: rawUrl, method = 'POST', headers = {}, body = null, allowLocal = false }) {
  const resolved = await validateApiUrl(rawUrl, { allowLocal }, lookupImpl);
  const response = fetchImpl === globalThis.fetch
    ? await requestPinned(resolved.url, resolved, signal, headers, proxy, method, body ? JSON.stringify(body) : null)
    : await fetchImpl(rawUrl, { method, redirect: 'manual', signal, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await readResponse(response);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Search API returned invalid JSON'); }
  if (!response.ok) {
    const detail = parsed?.error?.message || parsed?.error || parsed?.message;
    throw new Error(`Search API failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return parsed;
}

async function fetchTavilySearch(fetchImpl, lookupImpl, signal, proxy, apiKey, query, maxResults) {
  return fetchJsonApi(fetchImpl, lookupImpl, signal, proxy, {
    url: TAVILY_ENDPOINT,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ComfyMuse/0.2' },
    body: {
      api_key: apiKey,
      query,
      max_results: Math.min(Math.max(maxResults, 1), 20),
      include_answer: true,
      search_depth: 'advanced',
    },
  });
}

async function fetchSearxngSearch(fetchImpl, lookupImpl, signal, proxy, baseUrl, query) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = new URL('/search', base + '/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');
  url.searchParams.set('language', 'auto');
  url.searchParams.set('categories', 'general');
  return fetchJsonApi(fetchImpl, lookupImpl, signal, proxy, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'ComfyMuse/0.2' },
    allowLocal: true,
  });
}

function parseApiResults(items, limit, policy = {}) {
  const results = [];
  const seen = new Set();
  for (const item of items) {
    const rawUrl = String(item?.url || '').trim();
    if (!rawUrl || !allowedDomain(rawUrl, policy.allowedDomains)) continue;
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.toString())) continue;
    seen.add(url.toString());
    results.push({
      title: cleanText(item.title || url.hostname).slice(0, 300),
      url: url.toString(),
      snippet: cleanText(item.content || item.snippet || '').slice(0, 1200),
      trustLevel: classifySource(url, policy),
      ...(item.publishedDate || item.published_date ? { publishedAt: String(item.publishedDate || item.published_date).slice(0, 10) } : {}),
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseTavilyResults(payload, limit, policy = {}) {
  return {
    answer: cleanText(payload?.answer || '').slice(0, MAX_PAGE_CHARS),
    results: parseApiResults(Array.isArray(payload?.results) ? payload.results : [], limit, policy),
  };
}

function parseSearxngResults(payload, limit, policy = {}) {
  const answer = String(payload?.answers?.[0] || '').trim() || String(payload?.answer || '').trim();
  return {
    answer: cleanText(answer).slice(0, MAX_PAGE_CHARS),
    results: parseApiResults(Array.isArray(payload?.results) ? payload.results : [], limit, policy),
  };
}

export function createWebTool(fetchImpl = globalThis.fetch, lookupImpl = lookup, options = {}) {
  const cache = new Map();
  const defaultCacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  // 失败源短期冷却：同一工具实例内某个源失败后，冷却期内不再重试，避免每次搜索都撞墙
  const failures = new Map();
  const failureCooldownMs = Number.isFinite(options.failureCooldownMs) ? options.failureCooldownMs : DEFAULT_FAILURE_COOLDOWN_MS;
  function recordFailure(name) { failures.set(name, Date.now()); }
  function onCooldown(name) {
    const at = failures.get(name);
    return at !== undefined && Date.now() - at < failureCooldownMs;
  }

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
    description: 'Search public web pages or open a public URL for user-requested reference research. Fetched page content is returned to the agent and may be forwarded to your configured LLM provider.',
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
        query: { type: 'string', maxLength: 300 },
        url: { type: 'string', maxLength: 4096 },
        maxResults: { type: 'number', minimum: 1, maximum: MAX_RESULTS },
        timeoutMs: { type: 'number', minimum: 1000, maximum: DEFAULT_TIMEOUT_MS },
        maxOpenPages: { type: 'number', minimum: 0, maximum: 10 },
        allowNetwork: { type: 'boolean' },
        cacheTtlMs: { type: 'number', minimum: 0, maximum: 86400000 },
        allowedDomains: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        sourcePolicy: { type: 'object' },
        providers: { type: 'array', items: { type: 'string', enum: Object.keys(SEARCH_PROVIDERS) }, maxItems: 10, description: 'Fallback search providers to try in order' },
      },
      required: ['action'],
      // proxyUrl / baiduApiKey are intentionally NOT exposed to the model:
      // they are supplied by trusted configuration only.
      additionalProperties: false,
    },

    async execute({ action, query = '', url = '', maxResults = MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS, allowNetwork = true, cacheTtlMs = defaultCacheTtlMs, allowedDomains = [], sourcePolicy: inputPolicy = {}, providers = [], proxyUrl = '', baiduApiKey = '', searchApi = '', searchApiKey = '', searchApiBaseUrl = '', signal }) {
      if (allowNetwork === false) return { action, error: '未进行在线检索', researchStatus: 'disabled' };
      if (typeof fetchImpl !== 'function') return { action, error: 'Web fetch is unavailable in this runtime' };
      if (proxyUrl && !isLoopbackProxy(proxyUrl)) {
        return { action, error: 'Only loopback proxies are allowed' };
      }
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
        searchApi: `${String(searchApi || '').trim().toLowerCase()}:${Boolean(String(searchApiKey).trim())}:${String(searchApiBaseUrl || '').trim()}`,
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
          const apiKey = String(searchApiKey).trim();
          const baiduKey = String(baiduApiKey).trim();
          const apiName = String(searchApi || '').trim().toLowerCase();
          const attempted = [];
          // —— API 层（Tavily / SearXNG / 百度千帆，串行尝试，成功即返回）——
          // 与 HTML 抓取不同，API 返回结构化结果和摘要，质量更高；失败后走冷却并回退抓取
          const apiCandidates = [];
          if (apiName === 'tavily' && apiKey && !onCooldown('tavily')) {
            apiCandidates.push({ name: 'tavily', run: async (p, sig) => parseTavilyResults(await fetchTavilySearch(fetchImpl, lookupImpl, sig, p, apiKey, trimmed, maxResults), Math.min(maxResults, MAX_RESULTS), policy) });
          }
          if (apiName === 'searxng' && String(searchApiBaseUrl).trim() && !onCooldown('searxng')) {
            apiCandidates.push({ name: 'searxng', run: async (p, sig) => parseSearxngResults(await fetchSearxngSearch(fetchImpl, lookupImpl, sig, p, String(searchApiBaseUrl).trim(), trimmed), Math.min(maxResults, MAX_RESULTS), policy) });
          }
          if (baiduKey && !onCooldown('baidu-api')) {
            apiCandidates.push({ name: 'baidu-api', run: (p, sig) => fetchBaiduApi(fetchImpl, lookupImpl, sig, p, baiduKey, trimmed, maxResults, policy) });
          }
          for (const candidate of apiCandidates) {
            attempted.push(candidate.name);
            const apiRequest = createAbortSignal(providerTimeoutMs(), request.signal);
            try {
              let parsed;
              try {
                parsed = await candidate.run(proxy, apiRequest.signal);
              } catch (error) {
                if (error.name === 'AbortError') {
                  if (request.signal.aborted) throw error;
                  throw new Error(`${candidate.name} timed out`);
                }
                if (!fallbackProxy || !NETWORK_ERROR.test(error?.message || '')) throw error;
                const retryRequest = createAbortSignal(providerTimeoutMs(), request.signal);
                try {
                  parsed = await candidate.run(fallbackProxy, retryRequest.signal);
                } finally {
                  retryRequest.cleanup();
                }
              }
              if (parsed.results.length > 0 || parsed.answer) {
                const result = { action, query: trimmed, provider: candidate.name, attempted, answer: parsed.answer, results: parsed.results };
                if (ttlMs > 0) writeCache(key, result);
                return result;
              }
              failures.push(`${candidate.name}: no results returned`);
              recordFailure(candidate.name);
            } catch (error) {
              if (error.name === 'AbortError') return { action, error: 'Web request timed out or was cancelled' };
              failures.push(`${candidate.name}: ${error.message}`);
              recordFailure(candidate.name);
            } finally {
              apiRequest.cleanup();
            }
          }
          // —— HTML 抓取层（并行发起，按 provider 排序顺序合并，结果确定性不变）——
          const merged = [];
          const seen = new Set();
          const contributors = [];
          const availableProviders = searchProviders.filter(name => !onCooldown(name) && SEARCH_PROVIDERS[name]);
          attempted.push(...availableProviders);
          const providerTasks = availableProviders.map(name => (async () => {
            const spec = SEARCH_PROVIDERS[name];
            const endpoint = spec.buildUrl(trimmed);
            const response = await fetchForProvider(endpoint, {});
            const results = spec.parse(response.text, Math.min(maxResults, MAX_RESULTS), policy);
            return { name, results };
          })());
          const settledProviders = await Promise.allSettled(providerTasks);
          for (let index = 0; index < settledProviders.length; index += 1) {
            const settled = settledProviders[index];
            const name = availableProviders[index];
            if (settled.status === 'rejected') {
              if (settled.reason?.name === 'AbortError') throw settled.reason;
              failures.push(`${name}: ${settled.reason?.message || 'provider failed'}`);
              recordFailure(name);
              continue;
            }
            const { results } = settled.value;
            if (results.length > 0) contributors.push(name);
            for (const item of results) {
              const dedupeKey = item.url.split('#')[0];
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              merged.push(item);
            }
          }
          if (merged.length === 0) {
            return {
              action, query: trimmed,
              error: failures.length ? `All search providers failed (${failures.join('; ')})` : 'No search providers configured',
              researchStatus: 'search_failed',
              // 失败时也报告实际尝试过的来源（含 API 层），供界面显示"搜索来源/尝试了哪些搜索"
              attempted,
            };
          }
          const result = { action, query: trimmed, provider: contributors[0] || '', attempted, results: merged.slice(0, maxResults) };
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
export { cleanText, stripNoiseBlocks, isRegistrableDomain, parsePage, parseSearchResults, parseBingResults, parseBaiduResults, parseTavilyResults, parseSearxngResults, privateAddress, validateRemoteUrl, resolveProxy, resolveSearchProviders, systemProxyCandidate };

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
