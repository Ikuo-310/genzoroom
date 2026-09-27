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
export function adjustmentRowPosition(current: HTMLElement): HTMLElement | null {
  const row = current.closest('.adjustment-control');
  if (row) return row.querySelector('.adjustment-range');
  return current.closest('.grading-range-header')?.querySelector('.grading-range-title')
    ?? current.closest('.adjustment-category-header')?.querySelector('.adjustment-category-title') ?? null;
}

export function horizontalAdjustmentTarget(current: HTMLElement, direction: number): HTMLElement | undefined {
  const row = current.closest('.adjustment-control, .adjustment-category-header, .grading-range-header');
  if (!row) return;
  const selectors = row.matches('.adjustment-control')
    ? ['.adjustment-range', '.adjustment-number', '.adjustment-power', '.adjustment-reset']
    : row.matches('.grading-range-header') ? ['.grading-range-title', '.grading-range-toggle', '.grading-range-reset']
    : ['.adjustment-category-title', '[data-category-switch]', '.adjustment-category-reset'];
  const ordered = selectors.map((selector) => row.querySelector<HTMLElement>(selector))
    .filter((item): item is HTMLElement => !!item && !item.matches(':disabled') && !item.closest('[hidden], [inert]'));
  const index = ordered.indexOf(current);
  return index < 0 ? undefined : ordered[index + direction];
}
