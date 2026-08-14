import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// App.css was split into per-domain files under src/styles (cascade order is
// preserved by fixed import order in main.jsx). Concatenate in that same
// order so this layout contract still sees the full cascade.
const STYLE_ORDER = [
  'base.css',
  'header-floating.css',
  'layout-conversation.css',
  'execution-workspace.css',
  'settings-navigation.css',
  'prompt-library.css',
  'project-settings.css',
  'workbench-ia.css',
  'presets-themes.css',
];
const stylesDir = new URL('../src/styles/', import.meta.url);
const parts = [];
for (const name of STYLE_ORDER) {
  parts.push(await readFile(new URL(name, stylesDir), 'utf8'));
}
const css = parts.join('\n');

test('main workbench uses a flexible row instead of fixed grid columns', () => {
  assert.match(css, /Layout correction:[\s\S]*?\.body\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(css, /\.body\s*>\s*\.panel-left,[\s\S]*?flex:\s*1 1 auto;/);
});

test('collapsed sidebars release their reserved width', () => {
  assert.match(css, /\.body\s*>\s*\.project-sidebar\.collapsed\s*\{[\s\S]*?flex-basis:\s*52px;/);
  assert.match(css, /\.body\s*>\s*\.workspace-sidebar\.collapsed\s*\{[\s\S]*?flex-basis:\s*38px;/);
  assert.match(css, /@media \(min-width: 761px\) and \(max-width: 920px\)[\s\S]*?\.body > \.workspace-sidebar \{ display: flex; \}/);
});

test('asset and prompt workbenches can shrink without horizontal clipping', () => {
  assert.match(css, /\.asset-library-header,[\s\S]*?\.asset-library-grid\s*\{[\s\S]*?width:\s*min\(1120px, 100%\)/);
  assert.match(css, /\.prompt-library-workbench \.prompt-workbench-grid\s*\{[\s\S]*?minmax\(0, 1fr\)/);
  assert.ok(css.lastIndexOf('grid-template-columns: var(--prompt-workbench-sidebar-width) 12px minmax(0, 1fr) clamp(280px, 20vw, 360px)') > css.lastIndexOf('minmax(600px, 1fr)'));
});
