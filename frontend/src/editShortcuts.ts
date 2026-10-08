import { isPrimaryModifier, shortcutPlatform, type ShortcutPlatform } from './shortcutModifiers';

// Preserve native text editing, selection widgets, and IME composition.
export function isNativeEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input:not([type="range"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
}

export type ShortcutBinding = Readonly<{
  key?: string;
  code?: string;
  ignoreCase?: boolean;
  primary?: boolean;
  alternate?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  excludeAltGraph?: boolean;
}>;

const commandModifiers = { primary: false, alternate: false } as const;
const primaryModifiers = { primary: true, alternate: false } as const;
const clipboardModifiers = { ...primaryModifiers, shift: false, excludeAltGraph: true } as const;

export const shortcutBindings = {
  undo: [{ key: 'z', ignoreCase: true, ...primaryModifiers, shift: false }],
  redo: [
    { key: 'z', ignoreCase: true, ...primaryModifiers, shift: true },
    { key: 'y', ignoreCase: true, ...primaryModifiers, shift: false },
  ],
  copySettings: [{ key: 'c', ignoreCase: true, ...clipboardModifiers }],
  pasteSettings: [{ key: 'v', ignoreCase: true, ...clipboardModifiers }],
  copySelection: [{ key: 'c', ignoreCase: true, ...primaryModifiers, alternate: true, shift: false, excludeAltGraph: true }],
  pasteSelection: [{ key: 'v', ignoreCase: true, ...primaryModifiers, alternate: true, shift: false, excludeAltGraph: true }],
  viewerOriginal: [{ key: ']', ...commandModifiers, alt: false }],
  viewerBefore: [{ code: 'Backslash', ...commandModifiers, alt: false }],
  viewerFocusMode: [{ key: 'f', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  viewerFitRestore: [{ key: 'z', ignoreCase: true, ...commandModifiers, shift: true, alt: false }],
  homeOpenSelected: [{ key: 'd', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeOpenPreview: [{ key: 'p', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeOpenStackManager: [{ key: 's', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeRecent: [{ key: 'r', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeAlbums: [{ key: 'a', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeCalendar: [{ key: 'c', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeFavorites: [{ key: 'f', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeExport: [{ key: 'e', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  exportQueueToggle: [{ key: 'q', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  exportArmToggle: [{ key: 'w', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  homeSelectAll: [{ key: 'a', ignoreCase: true, ...clipboardModifiers }],
  calendarNavigatePrevious: [{ key: 'ArrowLeft', ...commandModifiers, shift: false, alt: false }],
  calendarNavigateNext: [{ key: 'ArrowRight', ...commandModifiers, shift: false, alt: false }],
  stackAddSelected: [{ key: 'a', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  workspaceReturnHome: [{ key: 'g', ignoreCase: true, ...commandModifiers, shift: false, alt: false }],
  scopeRed: [{ code: 'Numpad1', ...commandModifiers, shift: false, alt: false }],
  scopeGreen: [{ code: 'Numpad2', ...commandModifiers, shift: false, alt: false }],
  scopeBlue: [{ code: 'Numpad3', ...commandModifiers, shift: false, alt: false }],
  scopeYOnly: [{ code: 'Numpad0', ...commandModifiers, shift: false, alt: false }],
  scopeScale: [{ code: 'NumpadDecimal', ...commandModifiers, shift: false, alt: false }],
  thumbnailSizeDecrease: [{ code: 'NumpadSubtract', ...commandModifiers, shift: false, alt: false }],
  thumbnailSizeIncrease: [{ code: 'NumpadAdd', ...commandModifiers, shift: false, alt: false }],
  filmstripPrevious: [{ key: 'ArrowLeft', ...primaryModifiers, shift: true, alt: false, excludeAltGraph: true }],
  filmstripNext: [{ key: 'ArrowRight', ...primaryModifiers, shift: true, alt: false, excludeAltGraph: true }],
} as const satisfies Record<string, readonly ShortcutBinding[]>;

export type ShortcutId = keyof typeof shortcutBindings;
type ShortcutKeyEvent = Pick<KeyboardEvent, 'key'> & Partial<Pick<KeyboardEvent, 'code'>>;
type ShortcutEvent = ShortcutKeyEvent & Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
  & Partial<Pick<KeyboardEvent, 'getModifierState'>>;

function matchesBindingKey(event: ShortcutKeyEvent, binding: ShortcutBinding): boolean {
  return (binding.code === undefined || event.code === binding.code)
    && (binding.key === undefined || (binding.ignoreCase ? event.key.toLowerCase() : event.key) === binding.key);
}

// Releases must still match when modifiers changed while the key was held.
export function matchesShortcutKey(event: ShortcutKeyEvent, id: ShortcutId): boolean {
  return shortcutBindings[id].some(binding => matchesBindingKey(event, binding));
}

// Availability, event guards, and overlapping-command priority belong to callers.
export function matchesShortcut(event: ShortcutEvent, id: ShortcutId, platform: ShortcutPlatform = shortcutPlatform()): boolean {
  return shortcutBindings[id].some((binding: ShortcutBinding) => matchesBindingKey(event, binding)
    && (binding.primary === undefined
      ? (binding.ctrl === undefined || event.ctrlKey === binding.ctrl)
        && (binding.meta === undefined || event.metaKey === binding.meta)
      : binding.primary ? isPrimaryModifier(event, platform) : !event.ctrlKey && !event.metaKey)
    && (binding.alternate === undefined ? binding.alt === undefined || event.altKey === binding.alt : event.altKey === binding.alternate)
    && (binding.shift === undefined || event.shiftKey === binding.shift)
    && (!binding.excludeAltGraph || event.getModifierState?.('AltGraph') === false));
}

export function undoShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>, platform?: ShortcutPlatform) {
  if (event.isComposing) return null;
  return matchesShortcut(event, 'undo', platform) ? 'undo' : matchesShortcut(event, 'redo', platform) ? 'redo' : null;
}

export function sliderSteps(key: string) {
  return ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: 10, ArrowDown: -10 } as Record<string, number>)[key];
}

export function editClipboardShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>, platform?: ShortcutPlatform) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  return matchesShortcut(event, 'copySettings', platform) ? 'copy' : matchesShortcut(event, 'pasteSettings', platform) ? 'paste' : null;
}

export function editSelectionShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>, platform?: ShortcutPlatform) {
  // On Windows AltGraph may report both Ctrl and Alt. It is text input, not
  // this Primary+Alternate command.
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  return matchesShortcut(event, 'copySelection', platform) ? 'copy' : matchesShortcut(event, 'pasteSelection', platform) ? 'paste' : null;
}
