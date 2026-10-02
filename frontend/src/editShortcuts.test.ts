// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editClipboardShortcut, editSelectionShortcut, matchesShortcut, matchesShortcutKey, shortcutBindings, undoShortcut, type ShortcutId } from './editShortcuts';

function event(key: string, options: KeyboardEventInit = {}, altGraph = false) {
  const value = new KeyboardEvent('keydown', { key, ...options });
  Object.defineProperty(value, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' && altGraph });
  return value;
}

describe('command shortcut bindings', () => {
  it('preserves every Undo/Redo and clipboard modifier combination', () => {
    for (let mask = 0; mask < 32; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8), altGraph = !!(mask & 16);
      for (const key of ['z', 'Z', 'y', 'Y', 'c', 'C', 'v', 'V', 'x']) {
        const value = event(key, { ctrlKey, metaKey, altKey, shiftKey }, altGraph);
        const lower = key.toLowerCase();
        const undo = !altKey && (ctrlKey || metaKey)
          ? lower === 'z' ? shiftKey ? 'redo' : 'undo' : lower === 'y' && !shiftKey ? 'redo' : null : null;
        const clipboard = lower === 'c' ? 'copy' : lower === 'v' ? 'paste' : null;
        expect(undoShortcut(value)).toBe(undo);
        expect(editClipboardShortcut(value)).toBe(ctrlKey && !metaKey && !altKey && !shiftKey && !altGraph ? clipboard : null);
        expect(editSelectionShortcut(value)).toBe(ctrlKey && !metaKey && altKey && !shiftKey && !altGraph ? clipboard : null);
      }
    }
  });

  it.each(['isComposing', 'repeat', 'defaultPrevented'] as const)('preserves clipboard %s guards', guard => {
    for (const altKey of [false, true]) {
      for (const key of ['c', 'v']) {
        const value = event(key, { ctrlKey: true, altKey });
        Object.defineProperty(value, guard, { value: true });
        expect(editClipboardShortcut(value)).toBeNull();
        expect(editSelectionShortcut(value)).toBeNull();
      }
    }
    expect(undoShortcut(event('z', { ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it.each([
    ['viewerOriginal', ']', 'BracketRight'],
    ['viewerBefore', '\\', 'Backslash'],
    ['scopeRed', 'End', 'Numpad1'],
    ['scopeGreen', 'ArrowDown', 'Numpad2'],
    ['scopeBlue', 'PageDown', 'Numpad3'],
    ['scopeYOnly', 'Insert', 'Numpad0'],
    ['scopeScale', 'Delete', 'NumpadDecimal'],
  ] as const)('matches %s with its existing modifier policy', (id, key, code) => {
    for (let mask = 0; mask < 16; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8);
      expect(matchesShortcut(event(key, { code, ctrlKey, metaKey, altKey, shiftKey }), id))
        .toBe(!ctrlKey && !metaKey && !altKey && (id.startsWith('viewer') || !shiftKey));
    }
  });

  it('retains overlapping JIS matches for the Viewer to resolve in order', () => {
    const jis = event(']', { code: 'Backslash' });
    expect(matchesShortcut(jis, 'viewerOriginal')).toBe(true);
    expect(matchesShortcut(jis, 'viewerBefore')).toBe(true);
    expect(matchesShortcut(event('\\', { code: 'IntlYen' }), 'viewerBefore')).toBe(false);
    expect(matchesShortcutKey(event(']', { code: 'Backslash', ctrlKey: true, altKey: true }), 'viewerBefore')).toBe(true);
  });

  it('does not match top-row digits or period as Scope commands', () => {
    const ids: ShortcutId[] = ['scopeRed', 'scopeGreen', 'scopeBlue', 'scopeYOnly', 'scopeScale'];
    for (const [key, code] of [['0', 'Digit0'], ['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3'], ['.', 'Period']]) {
      for (const id of ids) expect(matchesShortcut(event(key, { code }), id)).toBe(false);
    }
  });

  it('matches Filmstrip movement only for Ctrl+Shift+Arrow without AltGraph', () => {
    for (const [id, key] of [['filmstripPrevious', 'ArrowLeft'], ['filmstripNext', 'ArrowRight']] as const) {
      expect(matchesShortcut(event(key, { ctrlKey: true, shiftKey: true }), id)).toBe(true);
      expect(matchesShortcut(event(key, { ctrlKey: true, shiftKey: true }, true), id)).toBe(false);
      for (const options of [{ shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true, altKey: true },
        { ctrlKey: true, shiftKey: true, metaKey: true }]) {
        expect(matchesShortcut(event(key, options), id)).toBe(false);
      }
    }
  });

  it('keeps event availability outside the binding matcher', () => {
    const value = event(']', { repeat: true, isComposing: true });
    Object.defineProperty(value, 'defaultPrevented', { value: true });
    expect(matchesShortcut(value, 'viewerOriginal')).toBe(true);
    expect(Object.keys(shortcutBindings)).toHaveLength(17);
  });

  it('separates focus mode and Fit restore from modified commands and Redo', () => {
    for (let mask = 0; mask < 16; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8);
      for (const key of ['f', 'F']) expect(matchesShortcut(event(key, { ctrlKey, metaKey, altKey, shiftKey }), 'viewerFocusMode'))
        .toBe(!ctrlKey && !metaKey && !altKey && !shiftKey);
      for (const key of ['z', 'Z']) expect(matchesShortcut(event(key, { ctrlKey, metaKey, altKey, shiftKey }), 'viewerFitRestore'))
        .toBe(!ctrlKey && !metaKey && !altKey && shiftKey);
    }
    expect(undoShortcut(event('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
  });
});
