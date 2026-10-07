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

it('uses the shared dark content surface while preserving Stack chrome and card panels', () => {
  const css = readFileSync('src/style.css', 'utf8');
  expect(css).toContain('.home-page, .stack-management-page { --bg-content: #111214; }');
  expect(css).toContain('.stack-content { min-height: 0; min-width: 0; overflow-y: auto; padding: 16px; background: var(--bg-content);');
  expect(css).toContain('.stack-management-header { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px; padding: 10px 16px; background: var(--bg-panel);');
  expect(css).toContain('.stack-control-bar { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 16px; background: var(--bg-panel);');
  expect(css).toContain('.stack-candidate-group { grid-column: span min(var(--stack-member-count), var(--stack-effective-columns)); min-width: 0; background: var(--bg-panel);');
  expect(css).toContain('.stack-content { min-height: 0; min-width: 0; overflow-y: auto; padding: 16px; background: var(--bg-content); scrollbar-color: var(--border-subtle) var(--bg-content);');
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
  expect(css).toMatch(/\.stack-cover-badge\s*\{[^}]*background:\s*var\(--status-match\);[^}]*color:\s*var\(--status-text\);/);
  expect(css).toMatch(/--cover-outline:\s*#6fa982;/);
  expect(css).not.toMatch(/\.stack-management-page \.stack-photo-wrapper\s*\{[^}]*background:/);
});

it('gives the empty unmatched drop target a compact minimum hit area', () => {
  const css = readFileSync('src/style.css', 'utf8');
  expect(css).toMatch(/\.stack-unmatched-empty\s*\{\s*min-height:\s*200px;\s*\}/);
  expect(css).toContain('.stack-unmatched-drop-target { outline: 2px solid var(--accent); outline-offset: 2px; background: var(--selection); }');
});
