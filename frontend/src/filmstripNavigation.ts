export function filmstripRevealOffset(left: number, right: number, visibleLeft: number, visibleRight: number): number {
  if (left < visibleLeft) return left - visibleLeft;
  if (right > visibleRight) return right - visibleRight;
  return 0;
}

export function revealFilmstripItem(scroll: HTMLElement, item: HTMLElement) {
  if (scroll.clientWidth === 0) return;
  const bounds = scroll.getBoundingClientRect();
  const thumbnail = item.getBoundingClientRect();
  const left = bounds.left + scroll.clientLeft;
  const offset = filmstripRevealOffset(thumbnail.left, thumbnail.right, left, left + scroll.clientWidth);
  if (offset) scroll.scrollLeft += offset;
}
