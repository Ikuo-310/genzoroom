import { describe, expect, it } from 'vitest';
import { editMenuPosition } from './EditSettingsMenu';

describe('viewer context menu placement', () => {
  it.each([
    [100, 120, 180, 140, 1000, 800, 100, 120],
    [970, 780, 180, 140, 1000, 800, 812, 652],
    [-30, -20, 180, 140, 1000, 800, 8, 8],
  ])('keeps the menu at %s,%s within a %s by %s viewport', (x, y, width, height, vw, vh, left, top) => {
    expect(editMenuPosition(x, y, width, height, vw, vh)).toEqual({ left, top });
  });
});
