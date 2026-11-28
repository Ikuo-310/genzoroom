import { useLayoutEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { ADJUSTMENT_SELECTION_CATEGORIES, adjustmentSelectionLabel } from './adjustmentSelection';
import type { RawCopySettingId } from './rawApi';

type SelectionId = AdjustmentId | RawCopySettingId;
type SelectionCategory = { id: string; label: string; groups: readonly { label?: string; ids: readonly SelectionId[] }[] };

type Props = {
  mode: 'copy' | 'paste';
  availableIds: readonly SelectionId[];
  onConfirm: (ids: SelectionId[]) => void;
  onCancel: () => void;
  categories?: readonly SelectionCategory[];
  labelKeys?: Partial<Record<RawCopySettingId, string>>;
  initialSelectedIds?: readonly SelectionId[];
  disabledIds?: readonly SelectionId[];
  disabledReasonKeys?: Partial<Record<RawCopySettingId, string>>;
};

function CategoryCheckbox({ checked, mixed, label, disabled, onChange }: {
  checked: boolean; mixed: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" checked={checked} aria-label={label}
    disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

export function AdjustmentSelectionDialog({ mode, availableIds, onConfirm, onCancel, categories, labelKeys,
  initialSelectedIds, disabledIds = [], disabledReasonKeys = {} }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const selectAllButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const selectableIds = availableIds.filter(id => !disabledIds.includes(id));
  const visibleCategories: readonly SelectionCategory[] = categories ?? ADJUSTMENT_SELECTION_CATEGORIES.map(category => ({
    id: category.id, label: category.label, groups: category.groups,
  }));
  const [selected, setSelected] = useState(() => new Set((initialSelectedIds ?? availableIds)
    .filter(id => availableIds.includes(id) && !disabledIds.includes(id))));

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    (availableIds.length > 0 ? confirmButton.current : selectAllButton.current)?.focus();
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

  function select(ids: readonly SelectionId[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked && !disabledIds.includes(id)) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function renderItem(id: SelectionId, groupLabel?: string) {
    const labelKey = labelKeys?.[id as RawCopySettingId] ?? (ADJUSTMENT_IDS.includes(id as AdjustmentId)
      ? adjustmentSelectionLabel(id as AdjustmentId) : id);
    const reasonKey = disabledReasonKeys[id as RawCopySettingId];
    return <label key={id} title={reasonKey ? t(reasonKey) : undefined}>
      <input type="checkbox" name={id} checked={selected.has(id)} disabled={disabledIds.includes(id)}
        aria-label={groupLabel ? `${t(groupLabel)} ${t(labelKey)}` : t(labelKey)}
        aria-describedby={reasonKey ? `${titleId}-${id}-reason` : undefined}
        onChange={(event) => select([id], event.target.checked)} />
      {t(labelKey)}{reasonKey && <span id={`${titleId}-${id}-reason`} className="selection-item-reason"> {t(reasonKey)}</span>}
    </label>;
  }

  return <dialog ref={dialog} className={`adjustment-selection-dialog${categories ? ' raw-adjustment-selection-dialog' : ''}`}
    aria-labelledby={titleId}
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
        onConfirm(availableIds.filter(id => selected.has(id)));
      } else if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <h2 id={titleId}>{t(mode === 'copy' ? 'workspace.selectCopy' : 'workspace.selectPaste')}</h2>
    <div className="selection-all-actions">
      <button ref={selectAllButton} type="button" className="tool-button" onClick={() => select(selectableIds, true)}>{t('workspace.selectAllAdjustments')}</button>
      <button type="button" className="tool-button" onClick={() => select(availableIds, false)}>{t('workspace.clearAllAdjustments')}</button>
    </div>
    <div className="adjustment-selection-categories">
      {visibleCategories.map((category) => {
        const categoryIds = category.groups.flatMap(group => group.ids);
        const singleItemCategory = !!categories && categoryIds.length === 1;
        const ids = categoryIds.filter(id => availableIds.includes(id));
        if (ids.length === 0) return null;
        if (singleItemCategory) return <div key={category.id} className="adjustment-selection-single">{renderItem(ids[0])}</div>;
        const selectable = ids.filter(id => !disabledIds.includes(id));
        const count = selectable.filter((id) => selected.has(id)).length;
        return <fieldset key={category.id}>
          <legend><label>
            <CategoryCheckbox checked={selectable.length > 0 && count === selectable.length} mixed={count > 0 && count < selectable.length}
              disabled={selectable.length === 0}
              label={t('workspace.selectAdjustmentCategory', { category: t(category.label) })}
              onChange={(checked) => select(ids, checked)} />
            {t(category.label)}
          </label></legend>
          {category.groups.map((group, index) => {
            const groupIds = group.ids.filter((id) => availableIds.includes(id));
            if (groupIds.length === 0) return null;
            return <div key={index} className="adjustment-selection-group">
              {group.label && <h3>{t(group.label)}</h3>}
              {groupIds.map(id => renderItem(id, group.label))}
            </div>;
          })}
        </fieldset>;
      })}
    </div>
    <div className="selection-confirm-actions">
      <button type="button" className="tool-button" onClick={onCancel}>{t('workspace.cancelSelection')}</button>
      <button ref={confirmButton} type="button" className="tool-button selection-confirm-button" disabled={selected.size === 0}
        onClick={() => onConfirm(availableIds.filter(id => selected.has(id)))}>
        {t(mode === 'copy' ? 'workspace.confirmCopy' : 'workspace.confirmPaste')}
      </button>
    </div>
  </dialog>;
}
