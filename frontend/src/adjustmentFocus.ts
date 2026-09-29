import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { isNativeEditingTarget } from './editShortcuts';
import { adjustmentRowPosition, horizontalAdjustmentTarget, revealAdjustment } from './adjustmentNavigation';

// Only mounted AdjustmentSliders participate; native ranges elsewhere stay independent.
const adjustments = new Map<HTMLInputElement, () => void>();
let activeAdjustment: HTMLInputElement | null = null;
// Scrolling can emit pointer enter/leave without mouse movement. Keep keyboard ownership until it moves.
let keyboardNavigation = false;
let mousePosition: { x: number; y: number } | null = null;

export function focusAdjustmentCategory() { activeAdjustment = null; }

export function navigateAdjustments(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'target' | 'preventDefault'>, current: HTMLElement) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
    || (isNativeEditingTarget(event.target) && !(event.target === current && current.matches('.adjustment-number')))
    || !event.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
  event.preventDefault();
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const scope = current.closest('.workspace-side-panel') ?? current.ownerDocument;
  const position = adjustmentRowPosition(current);
  const ordered = Array.from(scope.querySelectorAll<HTMLElement>('.adjustment-category-title, .grading-range-title, .adjustment-range'))
    .filter((item) => !item.closest('[hidden], [inert]') && !item.matches(':disabled')
      && (!(item instanceof HTMLInputElement) || isAvailable(item)));
  const index = position ? ordered.indexOf(position) : -1;
  // A category-disabled row still has an operable individual power button.
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const adjacent = index >= 0 ? ordered[index + direction] : position
    ? (direction > 0 ? ordered : [...ordered].reverse()).find((item) =>
      !!(position.compareDocumentPosition(item) & (direction > 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)))
    : undefined;
  const destination = horizontal ? horizontalAdjustmentTarget(current, event.key === 'ArrowRight' ? 1 : -1)
    : adjacent;
  if (destination) {
    focusAdjustmentTarget(destination, !horizontal);
  }
  return true;
}

function focusAdjustmentTarget(destination: HTMLElement, reveal: boolean) {
  const scope = destination.closest('.workspace-side-panel') ?? destination.ownerDocument;
  for (const item of scope.querySelectorAll<HTMLInputElement>('.adjustment-range')) adjustments.get(item)?.();
  keyboardNavigation = true;
  activeAdjustment = destination instanceof HTMLInputElement && destination.matches('.adjustment-range') ? destination : null;
  destination.focus({ preventScroll: true });
  if (reveal) revealAdjustment(destination);
}

export function restoreAdjustmentFocus(panel: HTMLElement, lastId: AdjustmentId | null): boolean {
  const available = Array.from(panel.querySelectorAll<HTMLInputElement>('.adjustment-range')).filter(item => {
    if (!isAvailable(item)) return false;
    for (let node: HTMLElement | null = item; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  });
  const destination = available.find(item => item.dataset.adjustmentId === lastId) ?? available[0];
  if (!destination) return false;
  focusAdjustmentTarget(destination, true);
  return true;
}

function isAvailable(element: HTMLInputElement | null): element is HTMLInputElement {
  return !!element && adjustments.has(element) && element.isConnected
    && !element.matches(':disabled') && !element.closest('[hidden], [inert]');
}

export function keyboardAdjustment(): HTMLInputElement | null {
  if (isAvailable(activeAdjustment)) return activeAdjustment;
  const focused = document.activeElement;
  return focused instanceof HTMLInputElement && isAvailable(focused) ? focused : null;
}

function adjustmentIdOf(element: HTMLInputElement | null): AdjustmentId | null {
  if (!isAvailable(element)) return null;
  const id = element.dataset.adjustmentId;
  return ADJUSTMENT_IDS.find((candidate) => candidate === id) ?? null;
}

export function activeAdjustmentId(): AdjustmentId | null {
  return adjustmentIdOf(keyboardAdjustment());
}

export function activateFromMouse(element: HTMLInputElement) {
  keyboardNavigation = false;
  activeAdjustment = element;
  const focused = element.ownerDocument.activeElement;
  // Release stale operation focus so Copy and arrows share the hover target, without ending text edits.
  if (focused instanceof HTMLElement && focused !== element
    && ((focused instanceof HTMLInputElement && adjustments.has(focused)) || focused.matches('.adjustment-category-title, .grading-range-title'))) focused.blur();
}

export function registerAdjustment(element: HTMLInputElement, commit: () => void) {
  adjustments.set(element, commit);
}

export function unregisterAdjustment(element: HTMLInputElement | null) {
  if (element) adjustments.delete(element);
  if (activeAdjustment === element) activeAdjustment = null;
  if (adjustments.size === 0) { keyboardNavigation = false; mousePosition = null; }
}

export function isRegisteredAdjustment(element: HTMLInputElement): boolean {
  return adjustments.has(element);
}

export function focusAdjustmentRange(element: HTMLInputElement | null) {
  activeAdjustment = element;
}

export function blurAdjustmentRange(element: HTMLInputElement | null) {
  if (activeAdjustment === element) activeAdjustment = null;
}

export function enterAdjustmentRange(element: HTMLInputElement | null, event: Pick<PointerEvent, 'clientX' | 'clientY'>) {
  if (!keyboardNavigation && isAvailable(element)) activateFromMouse(element);
  if (!keyboardNavigation) mousePosition = { x: event.clientX, y: event.clientY };
}

export function moveOverAdjustmentRange(element: HTMLInputElement | null, event: Pick<PointerEvent, 'clientX' | 'clientY' | 'movementX' | 'movementY'>) {
  const moved = mousePosition ? mousePosition.x !== event.clientX || mousePosition.y !== event.clientY
    : !keyboardNavigation || !!event.movementX || !!event.movementY;
  mousePosition = { x: event.clientX, y: event.clientY };
  if (moved && isAvailable(element)) activateFromMouse(element);
}

export function leaveAdjustmentRange(element: HTMLInputElement | null) {
  if (activeAdjustment === element && document.activeElement !== element) activeAdjustment = null;
}

export function startAdjustmentPointer(element: HTMLInputElement | null) {
  keyboardNavigation = false;
  if (isAvailable(element)) activeAdjustment = element;
}
