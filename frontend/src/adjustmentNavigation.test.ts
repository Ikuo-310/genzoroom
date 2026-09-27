import { describe, expect, it } from 'vitest';
import { revealOffset } from './adjustmentNavigation';

describe('adjustment reveal offset', () => {
  it.each([
    [120, 148, 0], [100, 128, 0], [272, 300, 0],
    [80, 108, -20], [60, 88, -40], [280, 308, 8], [350, 378, 78],
  ])('reveals %s..%s with only the necessary offset %s', (top, bottom, expected) => {
    expect(revealOffset(top, bottom, 100, 300)).toBe(expected);
  });
});
