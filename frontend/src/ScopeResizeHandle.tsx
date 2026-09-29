import { useRef } from 'react';

const MIN_SCOPE_PERCENT = 15;
const MAX_SCOPE_PERCENT = 70;

type Props = { value: number; onChange: (value: number) => void; label: string };

export function ScopeResizeHandle({ value, onChange, label }: Props) {
  const drag = useRef<{ startY: number; startValue: number; parentHeight: number } | null>(null);

  function resize(value: number) {
    onChange(Math.max(MIN_SCOPE_PERCENT, Math.min(MAX_SCOPE_PERCENT, value)));
  }

  return <div className="scope-resize-handle" role="separator" aria-orientation="horizontal" aria-label={label}
    aria-valuemin={MIN_SCOPE_PERCENT} aria-valuemax={MAX_SCOPE_PERCENT} aria-valuenow={Math.round(value)} tabIndex={0}
    onPointerDown={(event) => {
      const parentHeight = event.currentTarget.parentElement?.clientHeight ?? 0;
      if (parentHeight <= 0) return;
      drag.current = { startY: event.clientY, startValue: value, parentHeight };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start) resize(start.startValue + ((event.clientY - start.startY) / start.parentHeight) * 100);
    }}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); resize(value + 2); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); resize(value - 2); }
      else if (event.key === 'Home') { event.preventDefault(); resize(MIN_SCOPE_PERCENT); }
      else if (event.key === 'End') { event.preventDefault(); resize(MAX_SCOPE_PERCENT); }
    }} />;
}
