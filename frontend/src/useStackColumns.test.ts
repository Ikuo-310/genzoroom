import { expect, it } from 'vitest';
import { effectiveCardColumns } from './useStackColumns';

it('clamps to practical columns and restores the saved maximum on wide content', () => {
  expect(effectiveCardColumns(200, 832, 12)).toBe(3);
  expect(effectiveCardColumns(200, 424, 12)).toBe(2);
  expect(effectiveCardColumns(200, 90, 12)).toBe(1);
  expect(effectiveCardColumns(200, 1200, 12)).toBe(5);
  expect(effectiveCardColumns(280, 1200, 12)).toBe(4);
});
