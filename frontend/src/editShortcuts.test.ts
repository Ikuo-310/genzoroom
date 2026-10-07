// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editClipboardShortcut, editSelectionShortcut, matchesShortcut, matchesShortcutKey, shortcutBindings, undoShortcut, type ShortcutId } from './editShortcuts';
import { isPrimaryModifier, type ShortcutPlatform } from './shortcutModifiers';

function event(key: string, options: KeyboardEventInit = {}, altGraph = false) {
  const value = new KeyboardEvent('keydown', { key, ...options });
  Object.defineProperty(value, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' && altGraph });
  return value;
}

describe('command shortcut bindings', () => {
  it.each(['other', 'mac'] as const)('separates Home tabs from Primary select all on %s', platform => {
    for (let mask = 0; mask < 32; mask++) {
      const options = { ctrlKey: !!(mask & 1), metaKey: !!(mask & 2), altKey: !!(mask & 4), shiftKey: !!(mask & 8) };
      for (const [id, key] of [['homeRecent', 'R'], ['homeAlbums', 'A'], ['homeCalendar', 'C'], ['homeFavorites', 'F']] as const) {
        expect(matchesShortcut(event(key, options), id, platform)).toBe((mask & 15) === 0);
        expect(matchesShortcut(event(key.toLowerCase(), options), id, platform)).toBe((mask & 15) === 0);
      }
      const primaryMask = platform === 'mac' ? 2 : 1;
      expect(matchesShortcut(event('A', options, !!(mask & 16)), 'homeSelectAll', platform)).toBe(mask === primaryMask);
      expect(matchesShortcut(event('P', options), 'homeOpenPreview', platform)).toBe((mask & 15) === 0);
      expect(matchesShortcut(event('p', options), 'homeOpenPreview', platform)).toBe((mask & 15) === 0);
    }
  });
  it.each(['other', 'mac'] as const)('matches Primary-based commands strictly on %s', (platform: ShortcutPlatform) => {
    for (let mask = 0; mask < 32; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8), altGraph = !!(mask & 16);
      for (const key of ['z', 'Z', 'y', 'Y', 'c', 'C', 'v', 'V', 'x']) {
        const value = event(key, { ctrlKey, metaKey, altKey, shiftKey }, altGraph);
        const lower = key.toLowerCase();
        const primary = isPrimaryModifier(value, platform);
        const undo = primary && !altKey
          ? lower === 'z' ? shiftKey ? 'redo' : 'undo' : lower === 'y' && !shiftKey ? 'redo' : null : null;
        const clipboard = lower === 'c' ? 'copy' : lower === 'v' ? 'paste' : null;
        expect(undoShortcut(value, platform)).toBe(undo);
        expect(editClipboardShortcut(value, platform)).toBe(primary && !altKey && !shiftKey && !altGraph ? clipboard : null);
        expect(editSelectionShortcut(value, platform)).toBe(primary && altKey && !shiftKey && !altGraph ? clipboard : null);
      }
    }
  });

  it('preserves clipboard event guards and AltGraph exclusion', () => {
    for (const guard of ['isComposing', 'repeat', 'defaultPrevented'] as const) {
      const value = event('c', { ctrlKey: true });
      Object.defineProperty(value, guard, { value: true });
      expect(editClipboardShortcut(value, 'other')).toBeNull();
      expect(editSelectionShortcut(value, 'other')).toBeNull();
    }
    expect(editSelectionShortcut(event('c', { ctrlKey: true, altKey: true }, true), 'other')).toBeNull();
    expect(undoShortcut(event('z', { ctrlKey: true, isComposing: true }), 'other')).toBeNull();
  });

  it.each(['other', 'mac'] as const)('uses the OS Primary for Copy/Paste and Filmstrip on %s', (platform: ShortcutPlatform) => {
    const primary = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
    const opposite = platform === 'mac' ? { ctrlKey: true } : { metaKey: true };
    for (const key of ['c', 'v']) {
      const id = key === 'c' ? 'copySettings' : 'pasteSettings';
      expect(matchesShortcut(event(key, primary), id, platform)).toBe(true);
      expect(matchesShortcut(event(key, opposite), id, platform)).toBe(false);
      expect(matchesShortcut(event(key, { ...primary, ...opposite }), id, platform)).toBe(false);
    }
    for (const [id, key] of [['filmstripPrevious', 'ArrowLeft'], ['filmstripNext', 'ArrowRight']] as const) {
      expect(matchesShortcut(event(key, { ...primary, shiftKey: true }), id, platform)).toBe(true);
      expect(matchesShortcut(event(key, { ...opposite, shiftKey: true }), id, platform)).toBe(false);
      expect(matchesShortcut(event(key, { ...primary, ...opposite, shiftKey: true }), id, platform)).toBe(false);
      expect(matchesShortcut(event(key, { ...primary, shiftKey: true }, true), id, platform)).toBe(false);
    }
  });

  it.each(['other', 'mac'] as const)('matches selection Copy/Paste as Primary+Alternate on %s', (platform: ShortcutPlatform) => {
    const primary = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
    for (const [key, id] of [['c', 'copySelection'], ['v', 'pasteSelection']] as const) {
      expect(matchesShortcut(event(key, { ...primary, altKey: true }), id, platform)).toBe(true);
      expect(matchesShortcut(event(key, { ...primary, altKey: true }, true), id, platform)).toBe(false);
      expect(matchesShortcut(event(key, { ...primary, altKey: true, shiftKey: true }), id, platform)).toBe(false);
    }
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
    for (const platform of ['other', 'mac'] as const) for (let mask = 0; mask < 16; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8);
      expect(matchesShortcut(event(key, { code, ctrlKey, metaKey, altKey, shiftKey }), id, platform))
        .toBe(!ctrlKey && !metaKey && !altKey && (id.startsWith('viewer') || !shiftKey));
    }
  });

  it('retains overlapping JIS matches for the Viewer to resolve in order', () => {
    const jis = event(']', { code: 'Backslash' });
    expect(matchesShortcut(jis, 'viewerOriginal', 'other')).toBe(true);
    expect(matchesShortcut(jis, 'viewerBefore', 'other')).toBe(true);
    expect(matchesShortcut(event('\\', { code: 'IntlYen' }), 'viewerBefore', 'other')).toBe(false);
    expect(matchesShortcutKey(event(']', { code: 'Backslash', ctrlKey: true, altKey: true }), 'viewerBefore')).toBe(true);
  });

  it('does not match top-row digits or period as Scope commands', () => {
    const ids: ShortcutId[] = ['scopeRed', 'scopeGreen', 'scopeBlue', 'scopeYOnly', 'scopeScale'];
    for (const [key, code] of [['0', 'Digit0'], ['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3'], ['.', 'Period']]) {
      for (const id of ids) expect(matchesShortcut(event(key, { code }), id, 'other')).toBe(false);
    }
  });

  it('keeps event availability outside the binding matcher', () => {
    const value = event(']', { repeat: true, isComposing: true });
    Object.defineProperty(value, 'defaultPrevented', { value: true });
    expect(matchesShortcut(value, 'viewerOriginal', 'other')).toBe(true);
    expect(Object.keys(shortcutBindings)).toHaveLength(30);
  });

  it('matches Gallery return only for unmodified G', () => {
    for (const platform of ['other', 'mac'] as const) {
      expect(matchesShortcut(event('G'), 'workspaceReturnHome', platform)).toBe(true);
      expect(matchesShortcut(event('g'), 'workspaceReturnHome', platform)).toBe(true);
      expect(matchesShortcut(event('H'), 'workspaceReturnHome', platform)).toBe(false);
      expect(matchesShortcut(event('h'), 'workspaceReturnHome', platform)).toBe(false);
      for (const options of [
        { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
      ]) expect(matchesShortcut(event('g', options), 'workspaceReturnHome', platform)).toBe(false);
    }
    expect(undoShortcut(event('z', { ctrlKey: true }), 'other')).toBe('undo');
  });

  it('separates focus mode and Fit restore from Primary commands and Redo', () => {
    for (const platform of ['other', 'mac'] as const) for (let mask = 0; mask < 16; mask++) {
      const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), altKey = !!(mask & 4), shiftKey = !!(mask & 8);
      for (const key of ['f', 'F']) expect(matchesShortcut(event(key, { ctrlKey, metaKey, altKey, shiftKey }), 'viewerFocusMode', platform))
        .toBe(!ctrlKey && !metaKey && !altKey && !shiftKey);
      for (const key of ['z', 'Z']) expect(matchesShortcut(event(key, { ctrlKey, metaKey, altKey, shiftKey }), 'viewerFitRestore', platform))
        .toBe(!ctrlKey && !metaKey && !altKey && shiftKey);
    }
    expect(undoShortcut(event('Z', { ctrlKey: true, shiftKey: true }), 'other')).toBe('redo');
    expect(undoShortcut(event('Z', { metaKey: true, shiftKey: true }), 'mac')).toBe('redo');
  });

  it('matches Home develop only for unmodified D on both platforms', () => {
    for (const platform of ['other', 'mac'] as const) {
      expect(matchesShortcut(event('D'), 'homeOpenSelected', platform)).toBe(true);
      expect(matchesShortcut(event('d'), 'homeOpenSelected', platform)).toBe(true);
    }
    expect(Object.keys(shortcutBindings)).toHaveLength(30);
  });
  it('matches Export Queue only for unmodified Q regardless of case', () => {
    for (const platform of ['other', 'mac'] as const) {
      for (const key of ['Q', 'q']) expect(matchesShortcut(event(key), 'exportQueueToggle', platform)).toBe(true);
      for (const options of [
        { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      ]) expect(matchesShortcut(event('Q', options), 'exportQueueToggle', platform)).toBe(false);
    }
    expect(Object.keys(shortcutBindings)).toHaveLength(30);
  });
  it('matches Stack Add only for unmodified A without matching other commands', () => {
    for (const platform of ['other', 'mac'] as const) for (let mask = 0; mask < 16; mask++) {
      const value = event('A', { ctrlKey: !!(mask & 1), metaKey: !!(mask & 2), altKey: !!(mask & 4), shiftKey: !!(mask & 8) });
      expect(matchesShortcut(value, 'stackAddSelected', platform)).toBe(mask === 0);
      if (mask === 0) for (const id of Object.keys(shortcutBindings) as ShortcutId[]) {
        if (id !== 'stackAddSelected' && id !== 'homeAlbums') expect(matchesShortcut(value, id, platform)).toBe(false);
      }
    }
  });
  it('matches Calendar navigation arrows only without modifiers on either platform', () => {
    for (const platform of ['other', 'mac'] as const) for (let mask = 0; mask < 16; mask++) {
      const options = { ctrlKey: !!(mask & 1), metaKey: !!(mask & 2), altKey: !!(mask & 4), shiftKey: !!(mask & 8) };
      expect(matchesShortcut(event('ArrowLeft', options), 'calendarNavigatePrevious', platform)).toBe(mask === 0);
      expect(matchesShortcut(event('ArrowRight', options), 'calendarNavigateNext', platform)).toBe(mask === 0);
      expect(matchesShortcut(event('ArrowRight', options), 'calendarNavigatePrevious', platform)).toBe(false);
      expect(matchesShortcut(event('ArrowLeft', options), 'calendarNavigateNext', platform)).toBe(false);
    }
  });
});
