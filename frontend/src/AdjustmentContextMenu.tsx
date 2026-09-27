import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type AdjustmentMenuPosition = { trigger: HTMLElement; x: number; y: number };

export function AdjustmentContextMenu({ target, menuLabel, className, enabled, resetDisabled, pasteDisabled,
  enableLabel, disableLabel, resetLabel, copyLabel, pasteLabel, onToggle, onReset, onCopy, onPaste, onClose }: {
  target: AdjustmentMenuPosition; menuLabel: string; className: string;
  enabled: boolean; resetDisabled: boolean; pasteDisabled: boolean;
  enableLabel: string; disableLabel: string; resetLabel: string; copyLabel: string; pasteLabel: string;
  onToggle: () => void; onReset: () => void; onCopy: () => void; onPaste: () => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const fit = () => {
      const rect = element.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)) });
    };
    fit();
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('resize', fit);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      onClose();
      if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('resize', fit);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [onClose, target]);
  const invoke = (action: () => void) => {
    onClose();
    if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
    action();
  };
  return createPortal(<div ref={menu} role="menu" tabIndex={-1} aria-label={menuLabel}
    className={`workspace-menu-surface workspace-menu-list adjustment-context-menu ${className}`} style={position}
    onKeyDownCapture={(event) => event.stopPropagation()} onKeyUpCapture={(event) => event.stopPropagation()}
    onBlur={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onClose();
    }}>
    <button type="button" className="workspace-menu-item" role="menuitem" onClick={() => invoke(onCopy)}>{copyLabel}</button>
    <button type="button" className="workspace-menu-item" role="menuitem" disabled={pasteDisabled} onClick={() => invoke(onPaste)}>{pasteLabel}</button>
    <div role="separator" aria-orientation="horizontal" className="edit-settings-menu-separator" />
    <button type="button" className="workspace-menu-item" role="menuitem" onClick={() => invoke(onToggle)}>{enabled ? disableLabel : enableLabel}</button>
    <button type="button" className="workspace-menu-item" role="menuitem" disabled={resetDisabled} onClick={() => invoke(onReset)}>{resetLabel}</button>
  </div>, document.body);
}
