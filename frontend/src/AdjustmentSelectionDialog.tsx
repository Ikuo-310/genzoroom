import { useLayoutEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { ADJUSTMENT_SELECTION_CATEGORIES, adjustmentSelectionLabel } from './adjustmentSelection';

type Props = {
  mode: 'copy' | 'paste';
  availableIds: readonly AdjustmentId[];
  onConfirm: (ids: AdjustmentId[]) => void;
  onCancel: () => void;
};

function CategoryCheckbox({ checked, mixed, label, onChange }: {
  checked: boolean; mixed: boolean; label: string; onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" checked={checked} aria-label={label}
    onChange={(event) => onChange(event.target.checked)} />;
}

export function AdjustmentSelectionDialog({ mode, availableIds, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(() => new Set(availableIds));

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    element.querySelector<HTMLButtonElement>('button')?.focus();
    // Native modal inertness blocks interaction, but window key listeners still
    // need isolation. Block events aimed outside; inside events stop at React.
    const blockOutside = (event: KeyboardEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockOutside, true);
    window.addEventListener('keyup', blockOutside, true);
    return () => {
      window.removeEventListener('keydown', blockOutside, true);
      window.removeEventListener('keyup', blockOutside, true);
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  function select(ids: readonly AdjustmentId[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }

  return <dialog ref={dialog} className="adjustment-selection-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}
    onKeyUp={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); onCancel();
      } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // Let focused buttons keep their native Enter behavior. Enter on a
        // checkbox confirms the selection (Space remains its native toggle).
        if (event.repeat || event.target instanceof HTMLButtonElement) return;
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox' || selected.size === 0) return;
        event.preventDefault();
        onConfirm(ADJUSTMENT_IDS.filter((id) => availableIds.includes(id) && selected.has(id)));
      } else if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <h2 id={titleId}>{t(mode === 'copy' ? 'workspace.selectCopy' : 'workspace.selectPaste')}</h2>
    <div className="selection-all-actions">
      <button type="button" className="tool-button" onClick={() => select(availableIds, true)}>{t('workspace.selectAllAdjustments')}</button>
      <button type="button" className="tool-button" onClick={() => select(availableIds, false)}>{t('workspace.clearAllAdjustments')}</button>
    </div>
    <div className="adjustment-selection-categories">
      {ADJUSTMENT_SELECTION_CATEGORIES.map((category) => {
        const ids = category.ids.filter((id) => availableIds.includes(id));
        if (ids.length === 0) return null;
        const count = ids.filter((id) => selected.has(id)).length;
        return <fieldset key={category.id}>
          <legend><label>
            <CategoryCheckbox checked={count === ids.length} mixed={count > 0 && count < ids.length}
              label={t('workspace.selectAdjustmentCategory', { category: t(category.label) })}
              onChange={(checked) => select(ids, checked)} />
            {t(category.label)}
          </label></legend>
          {category.groups.map((group, index) => {
            const groupIds = group.ids.filter((id) => availableIds.includes(id));
            if (groupIds.length === 0) return null;
            return <div key={index} className="adjustment-selection-group">
              {group.label && <h3>{t(group.label)}</h3>}
              {groupIds.map((id) => <label key={id}>
                <input type="checkbox" name={id} checked={selected.has(id)}
                  aria-label={group.label ? `${t(group.label)} ${t(adjustmentSelectionLabel(id))}` : t(adjustmentSelectionLabel(id))}
                  onChange={(event) => select([id], event.target.checked)} />
                {t(adjustmentSelectionLabel(id))}
              </label>)}
            </div>;
          })}
        </fieldset>;
      })}
    </div>
    <div className="selection-confirm-actions">
      <button type="button" className="tool-button" onClick={onCancel}>{t('workspace.cancelSelection')}</button>
      <button type="button" className="tool-button" disabled={selected.size === 0}
        onClick={() => onConfirm(ADJUSTMENT_IDS.filter((id) => availableIds.includes(id) && selected.has(id)))}>
        {t(mode === 'copy' ? 'workspace.confirmCopy' : 'workspace.confirmPaste')}
      </button>
    </div>
  </dialog>;
}
