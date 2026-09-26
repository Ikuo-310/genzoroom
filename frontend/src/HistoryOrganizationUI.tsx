import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export type HistoryOperation = 'compactHistory' | 'trimHistory' | 'clearHistory' | 'resetEdits';
export type HistoryMenuTarget = { assetId: string; x: number; y: number; trigger: HTMLElement; cursor?: number };
const operations: { operation: HistoryOperation; label: string }[] = [
  { operation: 'compactHistory', label: 'workspace.historyCompact' },
  { operation: 'trimHistory', label: 'workspace.historyTrim' },
  { operation: 'clearHistory', label: 'workspace.historyClear' },
  { operation: 'resetEdits', label: 'workspace.historyReset' },
];

export function HistoryOrganizationMenu({ target, hasHistory, canReset, onSelect, onClose }: {
  target: HistoryMenuTarget; hasHistory: boolean; canReset: boolean;
  onSelect: (operation: HistoryOperation) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const element = menu.current!;
    const fit = () => {
      const rect = element.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)) });
    };
    fit();
    (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target) && !target.trigger.contains(event.target)) onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', fit);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', fit); };
  }, [target, onClose]);
  const close = () => { onClose(); if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true }); };
  return createPortal(<div ref={menu} role="menu" tabIndex={-1} aria-label={t('workspace.historyMenu')} className="history-organization-menu"
    style={position} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }} onKeyUp={(event) => event.stopPropagation()}>
    {operations.filter(({ operation }) => operation !== 'trimHistory' || target.cursor !== undefined).map(({ operation, label }) =>
      <button key={operation} type="button" role="menuitem" disabled={operation === 'resetEdits' ? !canReset
        : !hasHistory || (operation === 'trimHistory' && target.cursor === 0)}
        onClick={() => { close(); onSelect(operation); }}>{t(label)}</button>)}
  </div>, document.body);
}

export function HistoryConfirmationDialog({ operation, onConfirm, onCancel, returnFocus }: {
  operation: 'clearHistory' | 'resetEdits'; onConfirm: () => void; onCancel: () => void; returnFocus?: HTMLElement;
}) {
  const { t } = useTranslation();
  const titleId = useId(); const bodyId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    previousFocus.current = returnFocus ?? document.activeElement;
    element.showModal(); no.current?.focus();
    const blockOutside = (event: KeyboardEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockOutside, true);
    window.addEventListener('keyup', blockOutside, true);
    return () => {
      window.removeEventListener('keydown', blockOutside, true);
      window.removeEventListener('keyup', blockOutside, true);
      element.close();
    };
  }, []);
  useEffect(() => () => {
    // Wait until the closing render has re-enabled the invoking button.
    const previous = previousFocus.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  }, []);
  return <dialog ref={dialog} className="adjustment-selection-dialog history-confirmation-dialog"
    aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={(event) => { event.preventDefault(); onCancel(); }} onKeyUp={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.getModifierState('AltGraph')
        || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      } else if (!event.shiftKey) {
        if (event.key === 'Escape' || event.key.toLowerCase() === 'n') { event.preventDefault(); onCancel(); }
        else if (event.key.toLowerCase() === 'y') { event.preventDefault(); onConfirm(); }
        else if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) { event.preventDefault(); event.target.click(); }
      }
    }}>
    <h2 id={titleId}>{t(operation === 'clearHistory' ? 'workspace.historyClear' : 'workspace.historyReset')}</h2>
    <p id={bodyId}>{t(operation === 'clearHistory' ? 'workspace.historyClearConfirm' : 'workspace.historyResetConfirm')}</p>
    {operation === 'resetEdits' && <p className="history-confirmation-warning">
      <span className="history-confirmation-warning-icon" aria-hidden="true">⚠</span>
      {t('workspace.historyResetWarning')}
    </p>}
    <div className="selection-confirm-actions">
      <button ref={no} type="button" className="tool-button" onClick={onCancel}>{t('workspace.historyCancel')}</button>
      <button type="button" className="tool-button" onClick={onConfirm}>{t('workspace.historyContinue')}</button>
    </div>
  </dialog>;
}
