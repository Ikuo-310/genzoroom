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
