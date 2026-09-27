export function revealOffset(top: number, bottom: number, visibleTop: number, visibleBottom: number): number {
  if (top < visibleTop) return top - visibleTop;
  if (bottom > visibleBottom) return bottom - visibleBottom;
  return 0;
}

export function revealAdjustment(target: HTMLElement) {
  const scroll = target.closest<HTMLElement>('.develop-scroll-region');
  if (!scroll || scroll.clientHeight === 0 || getComputedStyle(scroll).overflowY === 'visible') return;
  const bounds = scroll.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const top = bounds.top + scroll.clientTop;
  const offset = revealOffset(item.top, item.bottom, top, top + scroll.clientHeight);
  if (offset) scroll.scrollTop += offset;
}
export function moveCategoryFocus(event: KeyboardEvent, current: HTMLButtonElement): boolean {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const selector = current.matches('.adjustment-category-title') && event.key === 'ArrowRight'
    ? '[data-category-switch]' : current.matches('[data-category-switch]') && event.key === 'ArrowLeft'
      ? '.adjustment-category-title' : null;
  if (!selector) return false;
  const destination = current.closest('.adjustment-category')?.querySelector<HTMLButtonElement>(selector);
  if (!destination || destination.disabled) return false;
  event.preventDefault();
  destination.focus({ preventScroll: true });
  return true;
}
