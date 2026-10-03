import { useLayoutEffect, useRef, useState } from 'react';

export function effectiveStackColumns(saved: number, width: number) {
  return Math.min(saved, Math.max(1, Math.floor((width + 12) / (120 + 12))));
}

export function useStackColumns(saved: number) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = (available: number) => { if (available > 0) setWidth(available); };
    const style = getComputedStyle(element);
    update(element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    // Measure usable content rather than window width so scrollbar/padding cannot split group spans.
    const observer = new ResizeObserver(entries => update(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { contentRef, effectiveColumns: width === null ? saved : effectiveStackColumns(saved, width) };
}
