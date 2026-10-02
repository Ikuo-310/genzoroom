// Preserve native text editing, selection widgets, and IME composition.
export function isNativeEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input:not([type="range"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
}

type ShortcutBinding = Readonly<{
  key?: string;
  code?: string;
  ignoreCase?: boolean;
  ctrlOrMeta?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt: boolean;
  shift?: boolean;
  excludeAltGraph?: boolean;
}>;

const commandModifiers = { ctrl: false, meta: false, alt: false } as const;
const clipboardModifiers = { ctrl: true, meta: false, alt: false, shift: false, excludeAltGraph: true } as const;

export const shortcutBindings = {
  undo: [{ key: 'z', ignoreCase: true, ctrlOrMeta: true, alt: false, shift: false }],
  redo: [
    { key: 'z', ignoreCase: true, ctrlOrMeta: true, alt: false, shift: true },
    { key: 'y', ignoreCase: true, ctrlOrMeta: true, alt: false, shift: false },
  ],
  copySettings: [{ key: 'c', ignoreCase: true, ...clipboardModifiers }],
  pasteSettings: [{ key: 'v', ignoreCase: true, ...clipboardModifiers }],
  copySelection: [{ key: 'c', ignoreCase: true, ...clipboardModifiers, alt: true }],
  pasteSelection: [{ key: 'v', ignoreCase: true, ...clipboardModifiers, alt: true }],
  viewerOriginal: [{ key: ']', ...commandModifiers }],
  viewerBefore: [{ code: 'Backslash', ...commandModifiers }],
  scopeRed: [{ code: 'Numpad1', ...commandModifiers, shift: false }],
  scopeGreen: [{ code: 'Numpad2', ...commandModifiers, shift: false }],
  scopeBlue: [{ code: 'Numpad3', ...commandModifiers, shift: false }],
  scopeYOnly: [{ code: 'Numpad0', ...commandModifiers, shift: false }],
  scopeScale: [{ code: 'NumpadDecimal', ...commandModifiers, shift: false }],
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
export function matchesShortcut(event: ShortcutEvent, id: ShortcutId): boolean {
  return shortcutBindings[id].some((binding: ShortcutBinding) => matchesBindingKey(event, binding)
    && (!binding.ctrlOrMeta || event.ctrlKey || event.metaKey)
    && (binding.ctrl === undefined || event.ctrlKey === binding.ctrl)
    && (binding.meta === undefined || event.metaKey === binding.meta)
    && event.altKey === binding.alt
    && (binding.shift === undefined || event.shiftKey === binding.shift)
    && (!binding.excludeAltGraph || event.getModifierState?.('AltGraph') === false));
}

export function undoShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>) {
  if (event.isComposing) return null;
  return matchesShortcut(event, 'undo') ? 'undo' : matchesShortcut(event, 'redo') ? 'redo' : null;
}

export function sliderSteps(key: string) {
  return ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: 10, ArrowDown: -10 } as Record<string, number>)[key];
}

export function editClipboardShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  return matchesShortcut(event, 'copySettings') ? 'copy' : matchesShortcut(event, 'pasteSettings') ? 'paste' : null;
}

export function editSelectionShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>) {
  // On Windows AltGraph may report both Ctrl and Alt. It is text input, not
  // this explicit Ctrl+Alt shortcut.
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  return matchesShortcut(event, 'copySelection') ? 'copy' : matchesShortcut(event, 'pasteSelection') ? 'paste' : null;
}
