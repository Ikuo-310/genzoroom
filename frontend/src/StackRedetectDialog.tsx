import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export function StackRedetectDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const titleId = useId(), bodyId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    previousFocus.current = document.activeElement;
    element.showModal(); cancel.current?.focus();
    // Native modal inertness does not stop window shortcut listeners.
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
    // Restore focus after the closing render has re-enabled the invoking control.
    if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus({ preventScroll: true });
  }, []);
  return <dialog ref={dialog} className="stack-redetect-dialog" aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={event => { event.preventDefault(); onCancel(); }} onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      } else if (event.key === 'Escape' && !event.shiftKey) { event.preventDefault(); onCancel(); }
    }}>
    <h2 id={titleId}>{t('stackManagement.detect')}</h2>
    <p id={bodyId}>{t('stackManagement.redetectConfirm')}</p>
    <div className="selection-confirm-actions">
      <button ref={cancel} type="button" onClick={onCancel}>{t('workspace.historyCancel')}</button>
      <button type="button" onClick={onConfirm}>{t('workspace.historyContinue')}</button>
    </div>
  </dialog>;
}
