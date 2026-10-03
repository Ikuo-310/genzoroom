// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('uses shared responsive columns for both grids and keeps excess group members inside their group', () => {
  const css = readFileSync('src/style.css', 'utf8');
  expect(css).toContain('.stack-candidate-grid, .stack-unmatched-grid { display: grid; grid-template-columns: repeat(var(--stack-effective-columns), minmax(0, 1fr));');
  expect(css).toContain('grid-column: span min(var(--stack-member-count), var(--stack-effective-columns))');
  expect(css).toContain('.stack-group-members { display: grid; grid-template-columns: repeat(min(var(--stack-member-count), var(--stack-effective-columns)), minmax(0, 1fr))');
  expect(css).not.toContain('grid-auto-flow: dense');
});

it('uses distinct semantic status colors', () => {
 const css = readFileSync('src/style.css', 'utf8');
 for (const [state, token] of [['matched','match'],['mismatch','mismatch'],['unavailable','unavailable'],['error','error']]) expect(css).toContain('.stack-evidence.' + state + ' { background: var(--status-' + token + ')');
});

it('keeps semantic status indicators non-selectable with a default cursor', () => {
 const css = readFileSync('src/style.css', 'utf8');
 expect(css).toMatch(/\.stack-evidence\s*\{[^}]*cursor:\s*default;[^}]*user-select:\s*none;/);
});

it('styles unmatched selection independently from the Cover badge', () => {
  const css = readFileSync('src/style.css', 'utf8');
  expect(css).toContain('.stack-management-page .stack-photo.stack-selection-active { background: var(--selection); border-color: var(--accent); }');
  expect(css).not.toContain('.stack-management-page .stack-photo[aria-pressed="true"]');
  expect(css).not.toMatch(/\.stack-management-page \.stack-cover\s*\{/);
  expect(css).toContain('.stack-cover-badge {');
});

it('gives the empty unmatched drop target a compact minimum hit area', () => {
  const css = readFileSync('src/style.css', 'utf8');
  expect(css).toMatch(/\.stack-unmatched-empty\s*\{\s*min-height:\s*120px;\s*\}/);
  expect(css).toContain('.stack-unmatched-drop-target { outline: 2px solid var(--accent); outline-offset: 2px; background: var(--selection); }');
});
