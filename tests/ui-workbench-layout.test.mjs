import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/App.css', import.meta.url), 'utf8');

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
