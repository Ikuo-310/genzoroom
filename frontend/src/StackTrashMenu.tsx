import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export function StackTrashMenu({ point, checked, onToggle, onClose }: {
  point: { x: number; y: number }; checked: boolean; onToggle: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  useLayoutEffect(() => {
    const bounds = ref.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(point.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(point.y, window.innerHeight - bounds.height - 8)) });
    ref.current?.querySelector('button')?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); onClose();
        if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" className="stack-photo-context-menu stack-trash-context-menu workspace-menu-surface" style={{ position: 'fixed', ...position, zIndex: 1000 }}>
    <button type="button" role="menuitem" className="stack-trash-menu-item" onClick={() => { onToggle(); onClose(); }}>
      {t(checked ? 'stackManagement.cancelTrash' : 'stackManagement.trash')}
    </button>
  </div>, document.body);
}
