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
