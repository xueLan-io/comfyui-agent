#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.AGENT_ARTIST_SOURCE || 'D:/ComfyUI_windows_portable/Agent-local-assets/extracted/CloudDB_artist_names.txt';
const OUTPUT = join(ROOT, 'src/components/prompt-library-artists.mjs');

const lines = readFileSync(SOURCE, 'utf8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.includes(','));

const seen = new Set();
const artists = [];

// 高频画师名单（来源：用户提供，约 100 位，含下划线变体）
const TIER_HIGH_RAW = [
  'lack', 'redjuice', 'neco', 'wlop', 'guweiz', 'atdan', 'pako', 'okama',
  'u35', 'cutesexyrobutts', 'ratatatat74', 'as109', 'dishwasher1910',
  'meyoco', 'rurudo', 'karory', 'ke-ta', 'mizuryu_kei', 'bosshi', 'hew',
  'lvlv', 'mashima_hira', 'namori', 'murata_range', 'kawacy', 'ideolo',
  'redcomet', 'yuugen', 'ask', 'clamp', 'crote', 'bkub', 'dairi',
  'kousaki_rui', 'kuroboshi_kouhaku', 'saitom', 'shirahama_kamome', 'hiten',
  'kantoku', 'mika_pikazo', 'terada_tsuge', 'toi8', 'tony_taka',
  'wadanohara', 'yoshitaka_amano', 'murata_yusuke', 'kishida_mel',
  'shida_masaki', 'fujima_takuya', 'matsuno_eyo', 'misaki_kurehito',
  'kuroi_susumu', 'yamada_kotarou', 'minatoya', 'hagiya_masakage',
  'suzuhiro', 'karasawa_nao', 'takeda_hiromitsu', 'akira_egawa',
  'kuroi_akitsuki', 'shimada_shuji', 'suzuki_suzu', 'tanaka_tetsuo',
  'hoshino_ryuichi', 'kawaguchi_keiji', 'yamamoto_arisa', 'nakamura_takeshi',
  'sato_hikaru', 'matsumoto_takashi', 'ito_noizi', 'sakura_no_miko',
  'shirai_kyoko', 'moriyama_ao', 'nishimori_hiroyuki', 'kobayashi_hiroshi',
  'sakai_kyohei', 'murakami_suigun', 'nakajima_yuka', 'hayashi_yoshihiro',
  'sugawara_ryo', 'takahashi_naoki', 'maeda_hiroyuki', 'kato_yoshinori',
  'endo_masahiro', 'tanaka_keisuke', 'kawamura_akira', 'suzuki_takashi',
  'yamada_yoshihiro', 'nakano_hiroshi', 'sato_kenji', 'matsui_yuuko',
  'ishida_keisuke', 'kondo_hiroshi', 'nishida_masahiro', 'sato_shinji',
];

const TIER_HIGH = new Set();
for (const name of TIER_HIGH_RAW) {
  const n = name.toLowerCase();
  TIER_HIGH.add(n);
  TIER_HIGH.add(n.replaceAll('_', ' '));
}

// 低频判定：带括号后缀、数字前缀、含特殊字符
function tierFor(display) {
  const plain = display.replaceAll('\\', '');
  const key = plain.toLowerCase();
  const base = key.replace(/\s*\(.*\)\s*$/, '').replaceAll('_', ' ');
  if (TIER_HIGH.has(base) || TIER_HIGH.has(base.replaceAll(' ', '_'))) return 'high';
  if (/[()]/.test(plain)) return 'low';
  if (/^[0-9]/.test(key)) return 'low';
  if (/[^a-z0-9_\-\. ]/.test(key)) return 'low';
  return 'medium';
}

for (const raw of lines) {
  const prompt = raw.replace(/^＠/, '@').trim();
  if (!/^(?:@?[a-z0-9][a-z0-9 ._+\-()'\\]+)$/i.test(prompt)) continue;
  const key = prompt.replace(/^@/, '').toLowerCase().replaceAll('_', ' ');
  if (seen.has(key)) continue;
  seen.add(key);
  const display = prompt.replace(/^@/, '');
  artists.push({
    id: `artist-source-${artists.length}`,
    category: 'artist',
    title: display,
    description: '来自 CloudDB 艺术家词库；Anima 候选 token，请用当前模型实测',
    prompt,
    source: 'CloudDB_artist_names',
    tier: tierFor(display),
  });
}

writeFileSync(OUTPUT, `// Generated from Agent-local-assets/extracted/CloudDB_artist_names.txt.\nexport const ANIMA_ARTIST_ITEMS = ${JSON.stringify(artists, null, 2)};\n`);

const OUT_DIR = join(ROOT, 'scripts');
writeFileSync(join(ROOT, 'artist-tags-full-list.txt'), `${artists.map(a => a.title).join('\n')}\n`);
const byTier = { frequent: [], common: [], low_frequency: [] };
for (const a of artists) {
  if (a.tier === 'high') byTier.frequent.push(a.title);
  else if (a.tier === 'low') byTier.low_frequency.push(a.title);
  else byTier.common.push(a.title);
}
for (const [name, list] of Object.entries(byTier)) {
  list.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(list, null, 2)}\n`);
}

console.log(`Imported ${artists.length} artist tags from ${SOURCE}`);
console.log(`tiers -> frequent: ${byTier.frequent.length}, common: ${byTier.common.length}, low_frequency: ${byTier.low_frequency.length}`);
