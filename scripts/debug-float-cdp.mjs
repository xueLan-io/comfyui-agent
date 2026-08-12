// CDP 调试助手: 连接运行时 Electron 应用(需 --remote-debugging-port=9333)
// 用法:
//   node scripts/debug-float-cdp.mjs           三段式生成生命周期复现
//   node scripts/debug-float-cdp.mjs --dump    列出页面并输出浮窗状态
//   node scripts/debug-float-cdp.mjs --fiber   输出浮窗组件 fiber 状态链
// 说明: 端口 9333 与 electron/main.mjs 的调试端口配置保持一致。

const CDP_BASE = 'http://127.0.0.1:9333';
const mode = process.argv[2] === '--dump' ? 'dump' : process.argv[2] === '--fiber' ? 'fiber' : 'repro';

async function pages() {
  return (await fetch(`${CDP_BASE}/json`)).json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method && this.listeners.has(message.method)) {
        for (const handler of this.listeners.get(message.method)) handler(message.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`Eval failed: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
    }
    return result.result?.value;
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}

async function findPages() {
  const all = await pages();
  return {
    main: all.find((p) => p.type === 'page' && !p.url.includes('floating')),
    float: all.find((p) => p.type === 'page' && p.url.includes('floating')),
    all,
  };
}

async function connectFloat() {
  const { float } = await findPages();
  if (!float) throw new Error('Floating window not found; call window.electronAPI.floatingShow() first');
  return Session.connect(float.webSocketDebuggerUrl);
}

const clickText = (session, text) => session.evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`);

const clickSel = (session, selector) => session.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`);

async function expandOrb(session) {
  const orb = await session.evaluate(`(() => {
    const o = document.querySelector('.quick-generate-orb');
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (orb) await session.click(orb.x, orb.y);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

const readStatus = (session) => session.evaluate(`(() => ({
  status: document.querySelector('.quick-generate-status')?.innerText ?? null,
  action: document.querySelector('.quick-generate-action')?.innerText ?? null,
  text: document.body.innerText.slice(0, 200),
}))()`);

async function waitTerminal(session, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const state = await readStatus(session);
    if (!state.status) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!/RUNNING|PREPARING|GENERATING/.test(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'timeout';
}

async function dumpMode() {
  const { all, main, float } = await findPages();
  console.log('PAGES:', all.map((p) => `${p.type} ${p.title} ${p.url}`).join('\n'));
  if (float) {
    const session = await Session.connect(float.webSocketDebuggerUrl);
    const state = await session.evaluate(`(() => ({
      readyState: document.readyState,
      cls: document.querySelector('.quick-generate-float')?.className ?? null,
      status: document.querySelector('.quick-generate-status')?.innerText ?? null,
      bodyText: document.body.innerText.slice(0, 300),
    }))()`);
    console.log('FLOAT:', JSON.stringify(state, null, 2));
  }
  if (main) console.log('MAIN FOUND:', main.url);
}

async function fiberMode() {
  const session = await connectFloat();
  const result = await session.evaluate(`(() => {
    const node = document.querySelector('.quick-generate-float');
    if (!node) return null;
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    const out = [];
    let cur = node[key];
    while (cur) {
      const t = cur.elementType || cur.type;
      const name = typeof t === 'function' ? (t.name || 'fn') : typeof t === 'string' ? t : (t && t.name) || 'anon';
      const states = [];
      let hook = cur.memoizedState;
      let i = 0;
      while (hook && i < 25) {
        const v = hook.memoizedState;
        let label;
        if (v && typeof v === 'object') {
          if (!Array.isArray(v) && typeof v.id === 'string') label = 'OBJ-ID=' + v.id;
          else if (v.statusMsg !== undefined || v.phase !== undefined) label = 'RUNTIME:' + JSON.stringify({ phase: v.phase, status: v.status, statusMsg: v.statusMsg });
          else if (Array.isArray(v)) label = 'ARRAY(' + v.length + ')';
          else label = 'OBJ:' + Object.keys(v).slice(0, 6).join(',');
        } else if (typeof v === 'string') label = 'STR=' + v.slice(0, 40);
        else if (v === null || v === undefined) label = String(v);
        else label = String(v);
        states.push(label);
        hook = hook.next;
        i++;
      }
      out.push({ name, states });
      cur = cur.return;
    }
    return out;
  })()`);
  console.log(JSON.stringify(result, null, 2));
}

async function reproMode() {
  const { main } = await findPages();
  if (main) {
    const mainSession = await Session.connect(main.webSocketDebuggerUrl);
    await mainSession.evaluate('window.electronAPI.floatingShow()');
  }
  const float = await connectFloat();
  const logs = [];
  float.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (params.type === 'error') logs.push('[float err] ' + text);
  });

  console.log('STEP 1: preset card immediate generate');
  await expandOrb(float);
  await clickText(float, '预设卡');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await clickText(float, '立即生成');
  console.log('final:', await waitTerminal(float, 60000));
  await expandOrb(float);
  console.log('expanded:', JSON.stringify(await readStatus(float)));
  await clickText(float, '清空');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('STEP 2: adjust generate (preset workflow kept)');
  await clickText(float, '预设卡');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await clickText(float, '调整后生成');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await clickSel(float, '.quick-generate-action');
  console.log('final:', await waitTerminal(float, 60000));
  await expandOrb(float);
  console.log('expanded:', JSON.stringify(await readStatus(float)));
  await clickText(float, '清空');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('STEP 3: direct quick generate (no preset)');
  await float.evaluate(`(() => {
    const ta = document.querySelector('.quick-prompt-card textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'a red fox in the snow');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await clickSel(float, '.quick-generate-action');
  console.log('final:', await waitTerminal(float, 60000));
  await expandOrb(float);
  console.log('expanded:', JSON.stringify(await readStatus(float)));

  console.log('LOGS:', logs.join('\n') || '(none)');
}

if (mode === 'dump') await dumpMode();
else if (mode === 'fiber') await fiberMode();
else await reproMode();
process.exit(0);