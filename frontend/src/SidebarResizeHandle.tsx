import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { sidebarResizeEnabled, type SidebarSide } from './sidebarSizing';

type Props = {
  side: SidebarSide;
  width: number;
  label: string;
  hidden: boolean;
  onResize: (side: SidebarSide, width: number) => void;
  onResizeEnd: () => void;
};

export function SidebarResizeHandle({ side, width, label, hidden, onResize, onResizeEnd }: Props) {
  const active = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const latest = useRef({ side, onResize, onResizeEnd });
  latest.current = { side, onResize, onResizeEnd };

  function finish() {
    if (!active.current) return;
    active.current = null;
    document.body.classList.remove('sidebar-resizing');
    latest.current.onResizeEnd();
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = active.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const direction = latest.current.side === 'left' ? 1 : -1;
      latest.current.onResize(latest.current.side, drag.startWidth + direction * (event.clientX - drag.startX));
      event.preventDefault();
    };
    const end = (event: PointerEvent) => {
      if (active.current?.pointerId === event.pointerId) finish();
    };
    const blur = () => finish();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', blur);
      document.body.classList.remove('sidebar-resizing');
    };
  }, []);

  useEffect(() => {
    if (hidden) finish();
  }, [hidden]);

  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (hidden || event.button !== 0 || !sidebarResizeEnabled()) return;
    active.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
    event.preventDefault();
  }

  return <div
    className={`sidebar-resize-handle ${side}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    hidden={hidden}
    onPointerDown={start}
    onLostPointerCapture={finish}
  />;
}
