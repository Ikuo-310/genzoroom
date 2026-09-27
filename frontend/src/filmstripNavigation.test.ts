import { describe, expect, it } from 'vitest';
import { filmstripRevealOffset } from './filmstripNavigation';

describe('Filmstrip reveal offset', () => {
  it.each([[120, 212, 0], [100, 192, 0], [208, 300, 0], [80, 172, -20], [260, 352, 52]])
    ('reveals %s..%s with only offset %s', (left, right, expected) => {
      expect(filmstripRevealOffset(left, right, 100, 300)).toBe(expected);
    });
});
