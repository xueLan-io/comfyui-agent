import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { classifySource, createWebTool, parsePage, parseBingResults, parseBaiduResults, parseTavilyResults, parseSearxngResults, stripNoiseBlocks, isRegistrableDomain, privateAddress, resolveProxy, resolveSearchProviders, clearSystemProxyCache } from '../src/agent/tools/web/index.mjs';

function response(text, contentType = 'text/html') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    body: null,
    async text() { return text; },
  };
}

test('web search extracts public result titles, URLs, and snippets', async () => {
  const fetchImpl = async url => {
    assert.match(String(url), /cn\.bing\.com\/search/);
    return response('<li class="b_algo"><h2><a href="https://93.184.216.34/character">Hero</a></h2><div class="b_caption"><p class="b_lineclamp2">Blue eyes and red coat</p></div></li>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero appearance' });
  assert.equal(result.error, undefined);
  assert.equal(result.provider, 'bing');
  assert.deepEqual(result.results, [{
    title: 'Hero',
    url: 'https://93.184.216.34/character',
    snippet: 'Blue eyes and red coat',
    trustLevel: 'unknown',
  }]);
});

test('Baidu AI Search maps the summary and references', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return response(JSON.stringify({
      choices: [{ message: { content: 'Baidu summary' } }],
      references: [{ url: 'https://example.com/hero', title: 'Hero reference', snippet: 'Blue eyes' }],
    }), 'application/json');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero appearance', baiduApiKey: 'test-key' });
  assert.equal(result.provider, 'baidu-api');
  assert.equal(result.answer, 'Baidu summary');
  assert.equal(result.results[0].title, 'Hero reference');
  assert.equal(request.url, 'https://qianfan.baidubce.com/v2/ai_search/web_summary');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Appbuilder-Authorization'], 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    messages: [{ role: 'user', content: 'Hero appearance' }],
    stream: false,
    resource_type_filter: [
      { type: 'web', top_k: 10 },
      { type: 'video', top_k: 0 },
      { type: 'image', top_k: 0 },
    ],
  });
});

test('Baidu AI Search falls back to scraping on API failure', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('qianfan.baidubce.com')) throw new Error('connection refused');
    return response('<li class="b_algo"><h2><a href="https://93.184.216.34/hero">Hero</a></h2></li>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', baiduApiKey: 'test-key' });
  assert.equal(result.provider, 'bing');
  assert.equal(result.results[0].title, 'Hero');
  assert.match(urls[0], /qianfan\.baidubce\.com/);
  assert.match(urls[1], /bing\.com\/search/);
});

test('web search falls back to the next provider when the first fails', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (String(url).includes('bing.com')) throw new Error('connection refused');
    return response('<a class="result__a" href="https://93.184.216.34/hero">Hero</a><div class="result__snippet">Blue eyes</div>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero appearance' });
  assert.equal(result.error, undefined);
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.results[0].title, 'Hero');
  assert.match(urls[0], /bing\.com\/search/);
  assert.match(urls[1], /duckduckgo\.com\/html/);
});

test('web search uses the configured provider list in order', async () => {
  const fetchImpl = async url => {
    assert.match(String(url), /baidu\.com\/s/);
    return response('<h3 class="t"><a href="http://www.baidu.com/link?url=abc">可莉 百度百科</a></h3>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: '可莉', providers: ['baidu'] });
  assert.equal(result.error, undefined);
  assert.equal(result.provider, 'baidu');
  assert.equal(result.results[0].title, '可莉 百度百科');
});

test('web search prefers Baidu for Chinese queries by default', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (!String(url).includes('baidu.com')) throw new Error('blocked');
    return response('<h3 class="t"><a href="http://www.baidu.com/link?url=a">奥黛塔 百度百科</a></h3>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: '原神 奥黛塔' });
  assert.equal(result.error, undefined);
  assert.equal(result.provider, 'baidu');
  assert.match(String(urls[0]), /baidu\.com\/s/);
});

test('web search merges and deduplicates results across providers', async () => {
  const fetchImpl = async url => {
    if (String(url).includes('bing.com')) return response('<li class="b_algo"><h2><a href="https://93.184.216.34/a">Alpha</a></h2><div class="b_caption"><p class="b_lineclamp2">Alpha snippet</p></div></li>');
    if (String(url).includes('duckduckgo.com')) return response('<a class="result__a" href="https://93.184.216.34/a">Alpha</a><div class="result__snippet">Alpha snippet</div><a class="result__a" href="https://93.184.216.34/b">Beta</a><div class="result__snippet">Beta snippet</div>');
    return response('<h3 class="t"><a href="http://www.baidu.com/link?url=x">Gamma</a></h3>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero appearance' });
  assert.equal(result.error, undefined);
  assert.equal(result.provider, 'bing');
  assert.deepEqual(result.results.map(item => item.title), ['Alpha', 'Beta', 'Gamma']);
});

test('web search probes every provider before applying maxResults', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (String(url).includes('bing.com')) return response('<li class="b_algo"><h2><a href="https://93.184.216.34/a">Alpha</a></h2></li>');
    if (String(url).includes('duckduckgo.com')) return response('<a class="result__a" href="https://93.184.216.34/b">Beta</a>');
    return response('<h3 class="t"><a href="https://93.184.216.34/c">Gamma</a></h3>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', maxResults: 1 });
  assert.equal(result.results.length, 1);
  assert.deepEqual(urls.map(url => new URL(url).hostname), ['cn.bing.com', 'html.duckduckgo.com', 'www.baidu.com']);
});

test('resolveSearchProviders orders providers by query language', () => {
  assert.deepEqual(resolveSearchProviders([], '原神'), ['baidu', 'bing', 'duckduckgo']);
  assert.deepEqual(resolveSearchProviders([], 'Hero'), ['bing', 'duckduckgo', 'baidu']);
  assert.deepEqual(resolveSearchProviders(['duckduckgo', 'baidu'], '原神'), ['baidu', 'duckduckgo']);
  assert.deepEqual(resolveSearchProviders(['unknown'], 'Hero'), ['bing', 'duckduckgo', 'baidu']);
});

test('parseBingResults decodes redirect urls and keeps snippet', () => {
  const html = '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?a=&u=aHR0cHM6Ly85My4xODQuMjE2LjM0L2NoYXJhY3Rlcg%3d%3d">Hero</a></h2><div class="b_caption"><p class="b_lineclamp2">Blue eyes and red coat</p></div></li>';
  const results = parseBingResults(html, 10);
  assert.equal(results[0].url, 'https://93.184.216.34/character');
  assert.equal(results[0].snippet, 'Blue eyes and red coat');
});

test('parseBaiduResults extracts titles from result blocks', () => {
  const html = '<h3 class="t"><a href="http://www.baidu.com/link?url=abc">可莉 百度百科</a></h3><h3 class="t"><a href="http://www.baidu.com/link?url=def">原神 wiki</a></h3>';
  const results = parseBaiduResults(html, 10);
  assert.equal(results.length, 2);
  assert.equal(results[1].title, '原神 wiki');
});

test('resolveProxy parses an explicit proxy url', () => {
  const proxy = resolveProxy('http://127.0.0.1:7897');
  assert.equal(proxy.host, '127.0.0.1');
  assert.equal(proxy.port, 7897);
  assert.equal(proxy.secure, false);
});

test('source trust uses configured domain policy, not search wording', async () => {
  assert.equal(classifySource('https://game.example/hero', { officialDomains: ['example'] }), 'official');
  assert.equal(classifySource('https://community.example/hero', { communityDomains: ['community.example'] }), 'community');
  assert.equal(classifySource('https://official.example/hero'), 'unknown');
});

test('web search filters results by allowed domains', async () => {
  const tool = createWebTool(async () => response(
    '<a class="result__a" href="https://allowed.example/hero">Allowed</a>'
      + '<a class="result__a" href="https://blocked.example/hero">Blocked</a>',
  ), async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'search', query: 'Hero', allowedDomains: ['allowed.example'] });
  assert.deepEqual(result.results.map(item => item.url), ['https://allowed.example/hero']);
});

test('network-disabled research is explicit and does not call fetch', async () => {
  const tool = createWebTool(async () => { throw new Error('fetch must not run'); });
  const result = await tool.execute({ action: 'search', query: 'Hero', allowNetwork: false });
  assert.equal(result.researchStatus, 'disabled');
  assert.equal(result.error, '未进行在线检索');
});

test('web cache reuses matching search results for the configured TTL', async () => {
  let calls = 0;
  const tool = createWebTool(async () => {
    calls++;
    return response('<a class="result__a" href="https://93.184.216.34/hero">Hero</a>');
  }, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  await tool.execute({ action: 'search', query: 'Hero', providers: ['duckduckgo'], cacheTtlMs: 10000 });
  const result = await tool.execute({ action: 'search', query: 'Hero', providers: ['duckduckgo'], cacheTtlMs: 10000 });
  assert.equal(calls, 1);
  assert.equal(result.cacheHit, true);
});

test('web open strips executable markup and limits the page shape', async () => {
  const tool = createWebTool(async () => response('<title>Hero</title><script>alert(1)</script><p>Blue eyes</p><p>Red coat</p>'), async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'open', url: 'https://93.184.216.34/character' });
  assert.equal(result.page.title, 'Hero');
  assert.equal(result.page.content, 'Hero Blue eyes Red coat');
  assert.doesNotMatch(result.page.content, /alert/);
});

test('web tool blocks private and local addresses', async () => {
  assert.equal(privateAddress('127.0.0.1'), true);
  assert.equal(privateAddress('192.168.1.20'), true);
  assert.equal(privateAddress('93.184.216.34'), false);
  const tool = createWebTool(async () => { throw new Error('fetch must not run'); });
  const result = await tool.execute({ action: 'open', url: 'http://127.0.0.1:8188/queue' });
  assert.match(result.error, /private|local/i);
});

test('web tool blocks IPv4-mapped loopback addresses', async () => {
  assert.equal(privateAddress('::ffff:127.0.0.1'), true);
  assert.equal(privateAddress('::ffff:7f00:1'), true);
  const tool = createWebTool(async () => { throw new Error('fetch must not run'); });
  const result = await tool.execute({ action: 'open', url: 'http://[::ffff:127.0.0.1]:8188/queue' });
  assert.match(result.error, /private|local/i);
});

test('web tool validates every redirect target', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 302,
    headers: new Headers({ location: 'http://127.0.0.1:8188/queue' }),
    body: null,
    async text() { return ''; },
  });
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'open', url: 'https://example.com/redirect' });
  assert.match(result.error, /private|local/i);
});

test('web tool rejects DNS rebinding when any resolved address is private', async () => {
  const tool = createWebTool(async () => { throw new Error('fetch must not run'); }, async () => [
    { address: '93.184.216.34' },
    { address: '127.0.0.1' },
  ]);
  const result = await tool.execute({ action: 'open', url: 'https://example.com/hero' });
  assert.match(result.error, /private|local/i);
});

test('HTTPS requests pin the resolved address used during validation', async () => {
  const originalRequest = https.request;
  let requestOptions;
  https.request = (options, callback) => {
    requestOptions = options;
    const responseStream = Readable.from([Buffer.from('<title>Hero</title><p>blue eyes</p>')]);
    responseStream.statusCode = 200;
    responseStream.headers = { 'content-type': 'text/html' };
    callback(responseStream);
    return { on() { return this; }, end() {} };
  };
  try {
    const tool = createWebTool(globalThis.fetch, async () => [{ address: '93.184.216.34', family: 4 }], { resolveProxy: () => null });
    const result = await tool.execute({ action: 'open', url: 'https://example.com/hero' });
    assert.equal(result.page.title, 'Hero');
    await new Promise((resolve, reject) => requestOptions.lookup('example.com', {}, (error, address) => error ? reject(error) : (assert.equal(address, '93.184.216.34'), resolve())));
    await new Promise((resolve, reject) => requestOptions.lookup('example.com', { all: true }, (error, addresses) => {
      if (error) return reject(error);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      resolve();
    }));
  } finally {
    https.request = originalRequest;
  }
});

test('web tool validates redirect targets against allowed domains', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 302,
    headers: new Headers({ location: 'https://blocked.example/hero' }),
    body: null,
    async text() { return ''; },
  });
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'open', url: 'https://allowed.example/redirect', allowedDomains: ['allowed.example'] });
  assert.match(result.error, /domain is not allowed/i);
});

test('web open decodes compressed non-UTF8 pages', async () => {
  const body = gzipSync(Buffer.from('<title>Caf\u00e9</title><p>blue eyes</p>', 'latin1'));
  const tool = createWebTool(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html; charset=iso-8859-1', 'content-encoding': 'gzip' }),
    body: {
      getReader() {
        let done = false;
        return { async read() { if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array(body) }; }, async cancel() {} };
      },
    },
  }), async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'open', url: 'https://93.184.216.34/hero' });
  assert.equal(result.page.title, 'Café');
  assert.match(result.page.content, /blue eyes/);
});

test('script-only pages do not become appearance content', async () => {
  const tool = createWebTool(async () => response('<script>const appearance = "long blue hair";</script><style>.x{}</style>'), async () => [{ address: '93.184.216.34' }]);
  const result = await tool.execute({ action: 'open', url: 'https://93.184.216.34/empty' });
  assert.equal(result.page.content, '');
});

test('parsePage keeps a bounded reference context', () => {
  const result = parsePage('https://93.184.216.34', 'text/html', '<title>Title</title><p>text</p>');
  assert.equal(result.title, 'Title');
  assert.equal(result.content, 'Title text');
});

test('denoises navigation, footer, and advertisement blocks from page content', () => {
  const html = '<title>Hero</title><nav>Home Menu Links</nav><article><p>Blue eyes and red coat</p></article><footer>Copyright 2024 All rights reserved</footer><div class="ad-banner">Buy now</div>';
  const page = parsePage('https://93.184.216.34', 'text/html', html);
  assert.match(page.content, /Blue eyes and red coat/);
  assert.doesNotMatch(page.content, /Home Menu Links/);
  assert.doesNotMatch(page.content, /Copyright 2024/);
  assert.doesNotMatch(page.content, /Buy now/);
});

test('stripNoiseBlocks keeps plain content without noise tags intact', () => {
  assert.equal(stripNoiseBlocks('<p>plain text</p>').trim(), 'plain text');
  const cleaned = stripNoiseBlocks('<nav>nav</nav><main>main</main>');
  assert.match(cleaned, /main/);
  assert.doesNotMatch(cleaned, /nav/);
});

test('isRegistrableDomain distinguishes registrable domains from deeper subdomains', () => {
  assert.equal(isRegistrableDomain('example'), true);
  assert.equal(isRegistrableDomain('example.com'), true);
  assert.equal(isRegistrableDomain('example.com.cn'), true);
  assert.equal(isRegistrableDomain('cn.bing.com'), false);
  assert.equal(isRegistrableDomain('com.cn'), false);
});

test('domain policy does not let deep subdomains of a subdomain through', async () => {
  const tool = createWebTool(
    async () => response('<a class="result__a" href="https://evil.cn.bing.com/hero">Bad</a><a class="result__a" href="https://cn.bing.com/ok">Ok</a>'),
    async () => [{ address: '93.184.216.34' }],
  );
  const result = await tool.execute({ action: 'search', query: 'Hero', allowedDomains: ['cn.bing.com'], providers: ['duckduckgo'] });
  assert.ok(!result.results || result.results.every(item => item.url === 'https://cn.bing.com/ok'));
});

test('Tavily search API maps structured answer and references', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return response(JSON.stringify({
      answer: 'Tavily answer',
      results: [{ title: 'Hero wiki', url: 'https://example.com/hero', content: 'Blue eyes', published_date: '2024-05-01T00:00:00Z' }],
    }), 'application/json');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'tavily', searchApiKey: 'tvly-test' });
  assert.equal(result.provider, 'tavily');
  assert.equal(result.answer, 'Tavily answer');
  assert.equal(result.results[0].title, 'Hero wiki');
  assert.equal(result.results[0].publishedAt, '2024-05-01');
  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).api_key, 'tvly-test');
});

test('SearXNG search API maps structured results from a self-hosted instance', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return response(JSON.stringify({
      results: [{ title: 'Hero wiki', url: 'https://example.com/hero', content: 'Blue eyes' }],
    }), 'application/json');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'searxng', searchApiBaseUrl: 'http://127.0.0.1:8888' });
  assert.equal(result.provider, 'searxng');
  assert.equal(result.results[0].title, 'Hero wiki');
  assert.match(String(request.url), /127\.0\.0\.1:8888\/search/);
});

test('SearXNG validates non-local endpoints instead of bypassing DNS safety checks', async () => {
  const tool = createWebTool(
    async () => { throw new Error('fetch must not run'); },
    async () => [{ address: '127.0.0.1', family: 4 }],
    { resolveProxy: () => null },
  );
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'searxng', searchApiBaseUrl: 'https://searx.example' });
  assert.match(result.error, /private|local/i);
});

test('Tavily success is used once and never discarded by a duplicate request', async () => {
  let tavilyCalls = 0;
  const fetchImpl = async url => {
    if (String(url).includes('tavily.com')) {
      tavilyCalls += 1;
      // 第二次调用模拟波动：旧代码重复 run 会把首次成功丢掉并回退抓取
      if (tavilyCalls > 1) throw new Error('connection reset by peer');
      return response(JSON.stringify({
        answer: 'Tavily answer',
        results: [{ title: 'Hero wiki', url: 'https://example.com/hero', content: 'Blue eyes' }],
      }), 'application/json');
    }
    return response('<a class="result__a" href="https://93.184.216.34/hero">Hero</a><div class="result__snippet">Blue eyes</div>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'tavily', searchApiKey: 'tvly-test' });
  assert.equal(result.provider, 'tavily');
  assert.equal(result.answer, 'Tavily answer');
  assert.equal(tavilyCalls, 1);
});

test('SearXNG search API is invoked exactly once on success', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    return response(JSON.stringify({
      results: [{ title: 'Hero wiki', url: 'https://example.com/hero', content: 'Blue eyes' }],
    }), 'application/json');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'searxng', searchApiBaseUrl: 'http://127.0.0.1:8888' });
  assert.equal(result.provider, 'searxng');
  assert.equal(calls, 1);
});

test('successful API responses report their only attempted provider', async () => {
  const tool = createWebTool(
    async () => response(JSON.stringify({ results: [{ title: 'Hero', url: 'https://example.com/hero', content: 'Blue eyes' }] }), 'application/json'),
    async () => [{ address: '93.184.216.34' }],
    { resolveProxy: () => null },
  );
  const result = await tool.execute({ action: 'search', query: 'Hero', searchApi: 'tavily', searchApiKey: 'tvly-test' });
  assert.deepEqual(result.attempted, ['tavily']);
});

test('parseTavilyResults applies the allowed-domain policy', () => {
  const parsed = parseTavilyResults({
    answer: 'Summary',
    results: [
      { title: 'A', url: 'https://allowed.example/a', content: 'Snippet A', published_date: '2024-05-01T00:00:00Z' },
      { title: 'B', url: 'https://blocked.example/b', content: 'Snippet B' },
    ],
  }, 10, { allowedDomains: ['allowed.example'] });
  assert.equal(parsed.answer, 'Summary');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].url, 'https://allowed.example/a');
  assert.equal(parsed.results[0].publishedAt, '2024-05-01');
});

test('parseSearxngResults reads answers and results', () => {
  const parsed = parseSearxngResults({
    answers: ['Searx answer'],
    results: [{ title: 'Hero', url: 'https://example.com/hero', content: 'Blue eyes' }],
  }, 10, {});
  assert.equal(parsed.answer, 'Searx answer');
  assert.equal(parsed.results[0].title, 'Hero');
});

test('failed providers are skipped during the cooldown window', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (String(url).includes('bing.com')) throw new Error('connection refused');
    return response('<a class="result__a" href="https://93.184.216.34/hero">Hero</a>');
  };
  const tool = createWebTool(fetchImpl, async () => [{ address: '93.184.216.34' }], { resolveProxy: () => null });
  const first = await tool.execute({ action: 'search', query: 'First query' });
  assert.equal(first.error, undefined);
  assert.equal(first.provider, 'duckduckgo');
  const second = await tool.execute({ action: 'search', query: 'Second query' });
  assert.equal(second.error, undefined);
  const bingCalls = urls.filter(u => u.includes('bing.com')).length;
  assert.equal(bingCalls, 1);
});

test('clearSystemProxyCache resets the cached system proxy', () => {
  assert.equal(typeof clearSystemProxyCache, 'function');
  clearSystemProxyCache();
  clearSystemProxyCache();
});
