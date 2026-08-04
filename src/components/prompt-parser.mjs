const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function isWrappedPrompt(value) {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function isSpecialPromptToken(value) {
  return /^<[^<>]+>$/.test(value.trim());
}

function parsePromptPart(source, start, end) {
  const value = source.slice(start, end);
  const weighted = value.match(/^(\(\s*[\s\S]*:\s*)(\d+(?:\.\d+)?)(\s*\))$/);
  if (weighted) {
    let raw = value.slice(1, value.lastIndexOf(':')).trim();
    while (isWrappedPrompt(raw)) raw = raw.slice(1, -1).trim();
    return { source: value, start, end, raw, weight: Number(weighted[2]), weighted: true, editableWeight: true, weightPrefix: weighted[1], weightSuffix: weighted[3] };
  }

  let raw = value;
  let nesting = 0;
  while (isWrappedPrompt(raw)) {
    raw = raw.slice(1, -1).trim();
    nesting++;
  }
  return { source: value, start, end, raw, weight: nesting > 0 ? 1.1 ** nesting : 1, nesting, editableWeight: !isSpecialPromptToken(value) };
}

export function splitPromptParts(text = '') {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;

  const addPart = end => {
    let partStart = start;
    let partEnd = end;
    while (partStart < partEnd && /\s/.test(text[partStart])) partStart++;
    while (partEnd > partStart && /\s/.test(text[partEnd - 1])) partEnd--;
    if (partStart < partEnd) parts.push(parsePromptPart(text, partStart, partEnd));
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (OPENERS.has(char)) {
      depth++;
      continue;
    }
    if (CLOSERS.has(char)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (char === ',' || char === '\n')) {
      addPart(index);
      start = index + 1;
    }
  }
  addPart(text.length);
  return parts;
}

export function insertPromptPart(text, prompt, index = splitPromptParts(text).length) {
  const candidate = String(prompt || '').trim();
  if (!candidate) return text;
  const parts = splitPromptParts(text);
  if (parts.some(part => normalizePromptPart(part.raw) === normalizePromptPart(candidate))) return text;
  const insertionIndex = Math.max(0, Math.min(parts.length, Number.isInteger(index) ? index : parts.length));
  const values = parts.map(part => part.source);
  values.splice(insertionIndex, 0, candidate);
  return values.join(', ');
}

export function reorderPromptPart(text, fromIndex, toIndex) {
  const parts = splitPromptParts(text);
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= parts.length) return text;
  const next = parts.slice();
  const [moved] = next.splice(fromIndex, 1);
  const insertionIndex = Math.max(0, Math.min(next.length, toIndex));
  next.splice(insertionIndex, 0, moved);
  return next.map(part => part.source).join(', ');
}

export function formatWeight(weight) {
  return Number(weight.toFixed(1)).toString();
}

export function serializePromptPart(part, weight) {
  if (part.editableWeight === false) return part.source;
  if (Math.abs(weight - part.weight) < 0.001) return part.source;
  if (part.weighted) return `${part.weightPrefix}${formatWeight(weight)}${part.weightSuffix}`;
  if (Math.abs(weight - 1) < 0.001) return part.raw;
  return `(${part.source}:${formatWeight(weight)})`;
}

export function updatePromptWeight(text, index, change, min = 0.1, max = 3) {
  const parts = splitPromptParts(text);
  const part = parts[index];
  if (!part) return text;
  const weight = Math.min(max, Math.max(min, Number((part.weight + change).toFixed(1))));
  return `${text.slice(0, part.start)}${serializePromptPart(part, weight)}${text.slice(part.end)}`;
}

export function removePromptPart(text, index) {
  const parts = splitPromptParts(text);
  const part = parts[index];
  if (!part) return text;

  let start = part.start;
  let end = part.end;
  while (end < text.length && /\s/.test(text[end])) end++;
  if (text[end] === ',') {
    end++;
    while (end < text.length && /\s/.test(text[end])) end++;
  } else {
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    if (text[start - 1] === ',') {
      start--;
      while (start > 0 && /\s/.test(text[start - 1])) start--;
    }
  }
  return `${text.slice(0, start)}${text.slice(end)}`.trim();
}

export function normalizePromptPart(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
