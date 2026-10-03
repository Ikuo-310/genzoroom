import { expect, it } from 'vitest';
import { effectiveStackColumns } from './useStackColumns';

it('clamps to practical columns and restores the saved maximum on wide content', () => {
  expect(effectiveStackColumns(6, 568)).toBe(4);
  expect(effectiveStackColumns(6, 358)).toBe(2);
  expect(effectiveStackColumns(6, 90)).toBe(1);
  expect(effectiveStackColumns(6, 1200)).toBe(6);
  expect(effectiveStackColumns(3, 1200)).toBe(3);
});
