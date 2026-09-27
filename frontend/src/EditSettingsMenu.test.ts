import { describe, expect, it } from 'vitest';
import { editMenuPosition } from './EditSettingsMenu';

describe('viewer context menu placement', () => {
  it.each([
    [100, 120, 260, 170, 1000, 800, 100, 120],
    [970, 780, 260, 170, 1000, 800, 732, 622],
    [-30, -20, 260, 170, 1000, 800, 8, 8],
  ])('keeps the menu at %s,%s within a %s by %s viewport', (x, y, width, height, vw, vh, left, top) => {
    expect(editMenuPosition(x, y, width, height, vw, vh)).toEqual({ left, top });
  });
});
