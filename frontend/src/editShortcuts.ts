// Preserve native text editing, selection widgets, and IME composition.
export function isNativeEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input:not([type="range"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
}

export function undoShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>) {
  if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && !event.shiftKey ? 'redo' : null;
}

export function sliderSteps(key: string) {
  return ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: 10, ArrowDown: -10 } as Record<string, number>)[key];
}

export function editClipboardShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>) {
  if (event.defaultPrevented || event.isComposing || event.repeat || !event.ctrlKey
    || event.metaKey || event.altKey || event.shiftKey || event.getModifierState('AltGraph')) return null;
  const key = event.key.toLowerCase();
  return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null;
}

export function editSelectionShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'getModifierState'>) {
  // On Windows AltGraph may report both Ctrl and Alt. It is text input, not
  // this explicit Ctrl+Alt shortcut.
  if (event.defaultPrevented || event.isComposing || event.repeat || !event.ctrlKey || !event.altKey
    || event.metaKey || event.shiftKey || event.getModifierState('AltGraph')) return null;
  const key = event.key.toLowerCase();
  return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null;
}
