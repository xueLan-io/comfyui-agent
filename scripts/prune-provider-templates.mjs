// Prune fabricated/padding entries from provider-templates.js.
//
// Criteria (auditable, one-shot maintenance script):
//  1. type must be handled by the runtime (src/agent/llm/provider.mjs only
//     implements 'ollama' and 'openai-compatible'); anything else cannot run.
//  2. Consumer-platform / telecom "X LLM" entries whose baseUrl host has no
//     public OpenAI-compatible chat API (e.g. api.wechat.com, api.shopee.com,
//     api.turkcell.com.tr) are fabricated padding.
//  3. Duplicate vendor entries ("*2", "备用" backup rows) with the same baseUrl
//     are noise; keep exactly one entry per vendor.
//  4. Image/video-generation API entries (Midjourney, Runway, Pika, Kling,
//     Replicate, fal, ElevenLabs, ...) do not expose chat completions and
//     cannot serve as chat providers.
//
// Run: node scripts/prune-provider-templates.mjs   (from repo root)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/provider-templates.js', import.meta.url));

// -- 1. types without a runtime handler (object KEYS of the entries)
const UNSUPPORTED_TYPES = new Set([
  'amazonbedrock', 'azureopenai', 'azurecognitive', 'cloudflaregateway',
  'cloudflareworkers', 'githubcopilot', 'googlevertex', 'modal',
  'sapcore', 'snowflake', 'vercelgateway', 'gitlabduo',
]);

// -- 2. fabricated consumer/telecom LLM endpoints
const FABRICATED = new Set([
  // consumer platforms / social / retail
  'wechat', 'weibo', 'douban', 'xiaohongshu', 'pinduoduo', 'meituan', 'didi',
  'bilibili', 'zhihu', 'kuaishou', 'xiaomi', 'xiaomi2', 'oppo', 'oppo2',
  'vivo', 'vivo2', 'honor', 'zte', 'lenovo', 'jd', 'jd2', 'netease',
  'netease2', 'meitu', 'huawei', 'huawei2', 'baidu3',
  // telecoms (no public OpenAI-compatible LLM APIs)
  'shopee', 'grab', 'gojek', 'sea', 'line', 'kakao', 'naver', 'rakuten',
  'yahoo', 'softbank', 'kddi', 'nttdocomo', 'singtel', 'telstra', 'vodafone',
  'orange', 'deutsche', 'telefonica', 'america', 'rcom', 'airtel', 'vi',
  'bsnl', 'etisalat', 'stc', 'zain', 'ooredoo', 'turkcell', 'telenor',
  'tele2', 'swisscom', 'telekom', 'bt', 'ee', 'three', 'o2', 'wind', 'tim',
  'movistar', 'claro', 'entel', 'personal', 'tigo', 'millicom', 'digicel',
  'bmobile', 'setar', 'dict', 'turk', 'avea', 'superonline', 'turknet',
  'dsmart', 'digiturk', 'turksat', 'pts',
  // numeric-variant padding (same host repeated)
  'vodafone2', 'vodafone3', 'vodafone4', 'vodafone5',
  'turkcell2', 'turkcell3', 'turkcell4', 'turkcell5', 'turkcell6',
  'turkcell7', 'turkcell8', 'turkcell9', 'turkcell10',
  'orange2', 'orange3', 'orange4', 'orange5',
  'deutsche2', 'deutsche3', 'deutsche4', 'deutsche5',
  'telefonica2', 'telefonica3', 'telefonica4', 'telefonica5',
  'america2', 'america3', 'america4', 'america5',
  'rcom2', 'rcom3', 'rcom4', 'rcom5',
  'airtel2', 'airtel3', 'airtel4', 'airtel5',
  'vi2', 'vi3', 'vi4', 'vi5',
  'bsnl2', 'bsnl3', 'bsnl4', 'bsnl5',
  'etisalat2', 'etisalat3', 'etisalat4', 'etisalat5',
  'stc2', 'stc3', 'stc4', 'stc5',
  'zain2', 'zain3', 'zain4', 'zain5',
]);

// -- 3. duplicate vendor entries and "备用" backup noise
const DUPLICATES = new Set([
  'zhipu', 'zhipu4', 'moonshot2', 'moonshot5', 'stepfun2', 'baichuan2',
  'sensenova2', 'infini2', 'lingyiwanwu2', 'siliconflow2', 'siliconflow4',
  'minimax2', 'minimax5', 'iflytek', 'iflyrec', 'bytedance', 'bytedance2',
  'alibaba', 'alibaba2', 'tencentcloud', 'tencent2', 'baidu2', 'deepseek6',
  'dashscope4', 'openrouter2', 'openrouter3', 'openrouter4', 'openrouter5',
  'openai6', 'anthropic6', 'google6', 'poke2api',
]);

// -- 4. image/video generation APIs that are not chat providers
const NOT_CHAT = new Set([
  'stabilityai', 'midjourney', 'runway', 'pika', 'kling', 'haiper', 'luma',
  'synthesia', 'elevenlabs', 'replicate', 'fal', 'leonardo', 'ideogram', 'flux',
]);

const REMOVE = new Set([...UNSUPPORTED_TYPES, ...FABRICATED, ...DUPLICATES, ...NOT_CHAT]);

const source = readFileSync(PATH, 'utf8');
const lines = source.split('\n');

const output = [];
const keptKeys = [];
const removed = [];
let inGroups = false;
let groupsBlockEnd = -1;
let groupsLines = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('export const TEMPLATE_GROUPS')) {
    inGroups = true;
    groupsLines.push(line);
    continue;
  }
  if (inGroups) {
    groupsLines.push(line);
    if (line.trim().endsWith('];')) {
      groupsBlockEnd = i;
      inGroups = false;
    }
    continue;
  }
  if (groupsBlockEnd >= 0) {
    output.push(line);
    continue;
  }
  const entryMatch = line.match(/^  ([A-Za-z0-9]+): \{ id: /);
  if (entryMatch) {
    const key = entryMatch[1];
    if (REMOVE.has(key)) { removed.push(key); continue; }
    keptKeys.push(key);
  }
  output.push(line);
}

// Rebuild TEMPLATE_GROUPS ids from the surviving templates.
const originalGroups = [];
{
  const raw = groupsLines.join('\n');
  const groupRe = /\{ key: '([^']+)', labelKey: '([^']+)', ids: \[([^\]]*)\]/g;
  let m;
  while ((m = groupRe.exec(raw))) {
    const ids = [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]);
    originalGroups.push({ key: m[1], labelKey: m[2], ids });
  }
}
const keptSet = new Set(keptKeys);
const rebuiltGroups = originalGroups.map(g => ({
  ...g,
  ids: g.ids.filter(id => keptSet.has(id)),
}));

const groupsText = rebuiltGroups.map(g =>
  `  { key: '${g.key}', labelKey: '${g.labelKey}', ids: [${g.ids.map(id => `'${id}'`).join(', ')}] }`
).join(',\n');

const out = `${output.join('\n')}\nexport const TEMPLATE_GROUPS = [\n${groupsText}\n];\n`;
writeFileSync(PATH, out);

console.log(`kept=${keptKeys.length} removed=${removed.length}`);
console.log('removed:', removed.join(', '));
