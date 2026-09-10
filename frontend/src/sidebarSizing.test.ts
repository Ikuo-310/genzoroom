import { describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_HANDLE_WIDTH,
  SIDEBAR_LIMITS,
  SIDEBAR_WIDTHS_STORAGE_KEY,
  VIEWER_MIN_WIDTH,
  clampResizedSidebar,
  defaultSidebarWidths,
  fitSidebarWidths,
  readSidebarWidths,
  saveSidebarWidths,
  sidebarResizeEnabled,
} from './sidebarSizing';

describe('Anshitsu sidebar width persistence', () => {
  it('restores a valid versioned value', () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ version: 1, left: 312, right: 366 })) };
    expect(readSidebarWidths(storage)).toEqual({ left: 312, right: 366 });
    expect(storage.getItem).toHaveBeenCalledWith(SIDEBAR_WIDTHS_STORAGE_KEY);
  });

  it.each([
    null,
    'not json',
    JSON.stringify({ version: 0, left: 300, right: 300 }),
    JSON.stringify({ version: 1, left: '300', right: null }),
  ])('falls back safely for missing, malformed, or old storage: %s', (stored) => {
    expect(readSidebarWidths({ getItem: () => stored })).toEqual(defaultSidebarWidths());
  });

  it('falls back per side when a stored width is outside its limits', () => {
    const stored = JSON.stringify({ version: 1, left: SIDEBAR_LIMITS.left.max + 1, right: 350 });
    expect(readSidebarWidths({ getItem: () => stored })).toEqual({ left: SIDEBAR_LIMITS.left.default, right: 350 });
  });

  it('survives blocked storage and saves a versioned payload', () => {
    expect(readSidebarWidths({ getItem: () => { throw new Error('blocked'); } })).toEqual(defaultSidebarWidths());
    const storage = { setItem: vi.fn() };
    saveSidebarWidths({ left: 300, right: 350 }, storage);
    expect(storage.setItem).toHaveBeenCalledWith(
      SIDEBAR_WIDTHS_STORAGE_KEY,
      JSON.stringify({ version: 1, left: 300, right: 350 }),
    );
    expect(() => saveSidebarWidths({ left: 300, right: 350 }, { setItem: () => { throw new Error('full'); } })).not.toThrow();
  });
});

describe('Anshitsu sidebar width constraints', () => {
  it.each([
    { leftOpen: true, rightOpen: false },
    { leftOpen: false, rightOpen: true },
    { leftOpen: true, rightOpen: true },
    { leftOpen: false, rightOpen: false },
  ])('leaves the Viewer usable with left=$leftOpen and right=$rightOpen', ({ leftOpen, rightOpen }) => {
    const container = 1000;
    const fitted = fitSidebarWidths({ left: SIDEBAR_LIMITS.left.max, right: SIDEBAR_LIMITS.right.max }, container, leftOpen, rightOpen);
    const panelWidth = (leftOpen ? fitted.left : 0) + (rightOpen ? fitted.right : 0);
    const handles = (Number(leftOpen) + Number(rightOpen)) * SIDEBAR_HANDLE_WIDTH;
    expect(container - panelWidth - handles).toBeGreaterThanOrEqual(VIEWER_MIN_WIDTH);
  });

  it('clamps each independently to its limits and the space beside the other panel', () => {
    expect(clampResizedSidebar('left', 100, 1200, 270, true)).toBe(SIDEBAR_LIMITS.left.min);
    expect(clampResizedSidebar('right', 900, 1200, 420, true)).toBe(408);
    expect(clampResizedSidebar('right', 900, 1600, 420, true)).toBe(SIDEBAR_LIMITS.right.max);
  });

  it('enables dragging only when the desktop fine-pointer query matches', () => {
    expect(sidebarResizeEnabled({ matchMedia: vi.fn(() => ({ matches: true })) as never })).toBe(true);
    expect(sidebarResizeEnabled({ matchMedia: vi.fn(() => ({ matches: false })) as never })).toBe(false);
    expect(sidebarResizeEnabled(undefined)).toBe(false);
  });
});
