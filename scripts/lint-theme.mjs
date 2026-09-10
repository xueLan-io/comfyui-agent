// Theme contract lint: every theme must cover the full token contract,
// have a settings preview class, and core dark surfaces must not leak
// hardcoded colors into component stylesheets.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = join(root, 'src', 'styles');

const CONTRACT = [
  'bg-canvas', 'bg-sidebar', 'bg-surface', 'bg-elevated', 'bg-hover', 'bg-active',
  'text-primary', 'text-secondary', 'text-muted', 'text-dim',
  'border-subtle', 'border-default', 'border-strong',
  'accent', 'accent-hover', 'accent-bg', 'accent-border',
  'green', 'green-bg', 'amber', 'amber-bg', 'red', 'red-bg', 'purple', 'purple-bg',
  'radius-sm', 'radius-md', 'radius-lg',
  'shadow-sm', 'shadow-md', 'shadow-lg',
  'shadow-glow-accent', 'shadow-glow-green', 'shadow-glow-red',
  'font-ui', 'font-display', 'font-mono',
  'bg-input', 'bg-composer', 'bg-floating', 'bg-overlay', 'bg-tinted-surface',
  'border-tinted', 'surface-highlight', 'shadow-color', 'text-on-accent',
  'content-gradient', 'panel-edge-gradient', 'bg-sunken', 'bg-sunken-strong',
  'bg-code-block', 'bg-media', 'halo-a', 'halo-b', 'atmosphere-opacity',
];

const THEME_IDS = ['system', 'light', 'dark', 'paper', 'mist', 'warm', 'navy', 'starry'];
const failures = [];

// --- token coverage ---
const core = readFileSync(join(styles, 'themes-core.css'), 'utf8');
const coverage = Object.fromEntries(THEME_IDS.map(id => [id, new Set()]));
for (const themeId of THEME_IDS) {
  const escaped = themeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`data-theme="${escaped}"\\]\\s*\\{([^}]*)\\}`, 'g');
  for (const match of core.matchAll(blockRe)) {
    for (const varMatch of match[1].matchAll(/--([a-z0-9-]+)\s*:/g)) {
      coverage[themeId].add(varMatch[1]);
    }
  }
}
for (const themeId of THEME_IDS) {
  const missing = CONTRACT.filter(token => !coverage[themeId].has(token));
  if (missing.length > 0) {
    failures.push(`${themeId}: missing tokens ${missing.join(', ')}`);
  }
}

// --- settings preview classes ---
const settings = readFileSync(join(styles, 'project-settings.css'), 'utf8');
for (const themeId of THEME_IDS) {
  if (!new RegExp(`\\.theme-preview-${themeId}\\b`).test(settings)) {
    failures.push(`project-settings.css: missing .theme-preview-${themeId}`);
  }
}

// --- banned dark surfaces and flat tones in component styles ---
const BANNED = ['background: #101821', 'background: #11161d', 'background: #10141a', 'background: #090b0e', 'background: #080d13', 'background: #0d141c', 'color: #d0d0d0', 'color: #c8c8c8', 'color: #dbe2e9', '#5c9fff'];
const componentFiles = readdirSync(styles)
  .filter(name => name.endsWith('.css') && !name.startsWith('themes-'))
  .map(name => join(styles, name));
for (const file of componentFiles) {
  const text = readFileSync(file, 'utf8');
  for (const literal of BANNED) {
    if (text.includes(literal)) {
      failures.push(`${file.replace(/\\/g, '/').split('/src/')[1]}: banned surface/tone literal ${literal}`);
    }
  }
}

if (failures.length > 0) {
  console.error('theme lint failed:');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log(`theme lint ok: ${THEME_IDS.length} themes x ${CONTRACT.length} tokens, previews + surface audit clean`);
