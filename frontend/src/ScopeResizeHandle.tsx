import { useRef } from 'react';
import { MAX_SCOPE_HEIGHT_PERCENT, MIN_SCOPE_HEIGHT_PERCENT } from './scopeSizing';

type Props = { value: number; onChange: (value: number) => void; onCommit: (value: number) => void; label: string };

export function ScopeResizeHandle({ value, onChange, onCommit, label }: Props) {
  const drag = useRef<{ startY: number; startValue: number; parentHeight: number; currentValue: number } | null>(null);

  function resize(value: number): number {
    const next = Math.max(MIN_SCOPE_HEIGHT_PERCENT, Math.min(MAX_SCOPE_HEIGHT_PERCENT, value));
    onChange(next);
    return next;
  }

  return <div className="scope-resize-handle" role="separator" aria-orientation="horizontal" aria-label={label}
    aria-valuemin={MIN_SCOPE_HEIGHT_PERCENT} aria-valuemax={MAX_SCOPE_HEIGHT_PERCENT} aria-valuenow={Math.round(value)} tabIndex={0}
    onPointerDown={(event) => {
      const parentHeight = event.currentTarget.parentElement?.clientHeight ?? 0;
      if (parentHeight <= 0) return;
      drag.current = { startY: event.clientY, startValue: value, parentHeight, currentValue: value };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start) start.currentValue = resize(start.startValue + ((event.clientY - start.startY) / start.parentHeight) * 100);
    }}
    onPointerUp={() => {
      if (drag.current) onCommit(drag.current.currentValue);
      drag.current = null;
    }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); onCommit(resize(value + 2)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); onCommit(resize(value - 2)); }
      else if (event.key === 'Home') { event.preventDefault(); onCommit(resize(MIN_SCOPE_HEIGHT_PERCENT)); }
      else if (event.key === 'End') { event.preventDefault(); onCommit(resize(MAX_SCOPE_HEIGHT_PERCENT)); }
    }} />;
}
