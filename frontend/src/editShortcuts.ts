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
