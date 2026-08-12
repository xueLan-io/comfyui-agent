import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.COMFY_AGENT_PROMPT_LIB_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prompts_collected/extracted');

let metadataPromise = null;

function splitLines(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function loadMetadata() {
  if (!metadataPromise) {
    metadataPromise = readFile(resolve(DATA_DIR, 'ALL_tag_metadata.tsv'), 'utf8').then(raw => {
      const rows = [];
      for (const line of splitLines(raw)) {
        const [tag, translation, group, usage, count, source] = line.split('\t', 6);
        if (!tag) continue;
        rows.push({
          tag,
          title: tag.replaceAll('_', ' '),
          translation: (translation || '').trim(),
          group: (group || '').trim() || '未分类',
          usage: (usage || '').trim(),
          sourceCount: Number.parseInt(count, 10) || 0,
          source: (source || '').trim(),
        });
      }
      return rows;
    }).catch(() => {
      metadataPromise = null;
      return [];
    });
  }
  return metadataPromise;
}

function scoreRow(row, q) {
  const tag = row.tag.toLowerCase();
  const title = row.title.toLowerCase();
  const translation = row.translation.toLowerCase();
  const group = row.group.toLowerCase();
  if (tag === q) return 100;
  if (tag.startsWith(q)) return 90;
  if (translation === q) return 85;
  if (translation.startsWith(q)) return 80;
  if (title.split(/\s+/).some(word => word.startsWith(q))) return 70;
  if (tag.split('_').some(word => word.startsWith(q))) return 70;
  if (translation.includes(q)) return 60;
  if (tag.includes(q)) return 55;
  if (group.includes(q)) return 40;
  return 0;
}

async function search({ query, group, limit } = {}) {
  const rows = await loadMetadata();
  const q = String(query || '').toLowerCase().trim();
  const g = String(group || '').toLowerCase().trim();
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const scored = [];
  for (const row of rows) {
    if (g && !(row.group.toLowerCase().includes(g) || g.includes(row.group.toLowerCase()))) continue;
    const score = q ? scoreRow(row, q) : 1;
    if (score > 0) scored.push({ score, row });
  }
  scored.sort((a, b) => b.score - a.score || b.row.sourceCount - a.row.sourceCount || a.row.tag.localeCompare(b.row.tag));
  const results = scored.slice(0, max).map(({ row }) => ({
    tag: row.tag,
    translation: row.translation,
    group: row.group,
    usage: row.usage,
    sourceCount: row.sourceCount,
    source: row.source,
  }));
  return { query: query || '', group: group || '', total: scored.length, results };
}

async function groups({ query } = {}) {
  const rows = await loadMetadata();
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.group, (counts.get(row.group) || 0) + 1);
  }
  const q = String(query || '').toLowerCase().trim();
  const list = [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .filter(item => !q || item.group.toLowerCase().includes(q))
    .sort((a, b) => b.count - a.count);
  return { total: list.length, groups: list };
}

export const PromptLibraryTool = {
  name: 'prompt_library',
  description: 'Search the local Danbooru prompt-tag library (50k+ tags with Chinese translations, categories, and usage counts) for the correct English tags of a character, series, style, or detail. Use it before web search. Local-only, no network.',
  category: 'enhancement',
  tags: ['prompt', 'tags', 'danbooru', 'local'],
  timeout_ms: 10000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      group: { type: 'string' },
      total: { type: 'number' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string' },
            translation: { type: 'string' },
            group: { type: 'string' },
            usage: { type: 'string' },
            sourceCount: { type: 'number' },
            source: { type: 'string' },
          },
        },
      },
      groups: { type: 'array', items: { type: 'object', properties: { group: { type: 'string' }, count: { type: 'number' } } } },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'groups'], description: 'search returns matching tags; groups lists the available tag categories' },
      query: { type: 'string', description: 'English tag fragment or Chinese concept to search' },
      group: { type: 'string', description: 'Filter by tag category (use the groups action to list them)' },
      limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max results, default 20' },
    },
  },

  async execute(input = {}) {
    try {
      return input.action === 'groups' ? await groups(input) : await search(input);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};
