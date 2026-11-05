import { useLayoutEffect, useRef, useState } from 'react';

export function effectiveCardColumns(cardWidth: number, width: number, gap: number) {
  return Math.max(1, Math.floor((width + gap) / (cardWidth + gap)));
}

export function useStackColumns(cardWidth: number, gap = 12, inset = 0) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = (available: number) => { if (available > inset) setWidth(available - inset); };
    const style = getComputedStyle(element);
    update(element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    if (typeof ResizeObserver === 'undefined') return;
    // Measure usable content rather than window width so scrollbar/padding cannot split group spans.
    const observer = new ResizeObserver(entries => update(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { contentRef, effectiveColumns: width === null ? 1 : effectiveCardColumns(cardWidth, width, gap) };
}
