import { describe, expect, it } from 'vitest';
import { formatShortcut } from './shortcutDisplay';

describe('shortcut binding display', () => {
  it('formats plain keys and modifier commands', () => {
    expect(formatShortcut('workspaceReturnHome', 'other')).toBe('H');
    expect(formatShortcut('homeOpenSelected', 'other')).toBe('D');
    expect(formatShortcut('stackAddSelected', 'other')).toBe('A');
    expect(formatShortcut('stackAddSelected', 'mac')).toBe('A');
    expect(formatShortcut('viewerFocusMode', 'other')).toBe('F');
    expect(formatShortcut('viewerFitRestore', 'other')).toBe('Shift+Z');
    expect(formatShortcut('copySettings', 'other')).toBe('Ctrl+C');
    expect(formatShortcut('copySelection', 'other')).toBe('Ctrl+Alt+C');
    expect(formatShortcut('undo', 'other')).toBe('Ctrl+Z');
    expect(formatShortcut('redo', 'other')).toBe('Ctrl+Shift+Z / Ctrl+Y');
  });
  it('formats Primary and Alternate using platform-specific modifier labels', () => {
    expect(formatShortcut('undo', 'mac')).toBe('⌘+Z');
    expect(formatShortcut('redo', 'mac')).toBe('⌘+⇧+Z / ⌘+Y');
    expect(formatShortcut('viewerFitRestore', 'mac')).toBe('⇧+Z');
    expect(formatShortcut('copySettings', 'mac')).toBe('⌘+C');
    expect(formatShortcut('pasteSettings', 'mac')).toBe('⌘+V');
    expect(formatShortcut('copySelection', 'mac')).toBe('⌘+⌥+C');
    expect(formatShortcut('pasteSelection', 'mac')).toBe('⌘+⌥+V');
    expect(formatShortcut('filmstripPrevious', 'mac')).toBe('⌘+⇧+←');
    expect(formatShortcut('filmstripNext', 'mac')).toBe('⌘+⇧+→');
  });
  it('formats logical arrows and physical codes', () => {
    expect(formatShortcut('filmstripPrevious', 'other')).toBe('Ctrl+Shift+←');
    expect(formatShortcut('filmstripNext', 'other')).toBe('Ctrl+Shift+→');
    expect(formatShortcut('redo', 'other')).toBe('Ctrl+Shift+Z / Ctrl+Y');
    expect(formatShortcut('viewerFitRestore', 'other')).toBe('Shift+Z');
    expect(formatShortcut('viewerBefore', 'other')).toBe('\\');
    expect(formatShortcut('viewerOriginal', 'other')).toBe(']');
    expect(formatShortcut('scopeRed', 'other')).toBe('Numpad 1');
    expect(formatShortcut('scopeGreen', 'other')).toBe('Numpad 2');
    expect(formatShortcut('scopeBlue', 'other')).toBe('Numpad 3');
    expect(formatShortcut('scopeYOnly', 'other')).toBe('Numpad 0');
    expect(formatShortcut('scopeScale', 'other')).toBe('Numpad .');
  });
});
