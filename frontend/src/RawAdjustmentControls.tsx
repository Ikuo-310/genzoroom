import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { commitAdjustmentEdits, focusAdjustmentCategory, navigateAdjustments, preserveAdjustmentNumberFocus } from './adjustmentFocus';
import type { AdjustmentId } from './editing';
import { TINT_TRACK_GRADIENT, TEMPERATURE_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
import type { RawControlId, RawHistoryOperation } from './rawApi';
import type { useRawDocument } from './useRawDocument';

type RawCategoryId = 'basic' | 'color';
const bindings: { category: RawCategoryId; controls: RawControlId[]; ids: AdjustmentId[] }[] = [
  { category: 'color', controls: ['wb.temp', 'wb.tint', 'color.vibrance', 'color.saturation'], ids: ['temperature', 'tint', 'vibrance', 'saturation'] },
  { category: 'basic', controls: ['light.exposure', 'light.contrast', 'light.highlights', 'light.whites', 'light.shadows', 'light.blacks'],
    ids: ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] },
];

export function RawAdjustmentControls({ raw, disabled = false }: { raw: NonNullable<ReturnType<typeof useRawDocument>>; disabled?: boolean }) {
  const { t } = useTranslation();
  const settings = raw.settings;
  const panel = useRef<HTMLDivElement>(null);
  const operate = (operation: RawHistoryOperation) => {
    if (panel.current) commitAdjustmentEdits(panel.current);
    raw.operate(operation);
  };
  const locked = disabled || !!raw.locked || !!raw.editError || raw.status !== 'ready';
  const actionsLocked = locked || !!raw.historyLoading || !!raw.historyError || !raw.history;
  return <div className="raw-adjustment-controls" ref={panel} onPointerDownCapture={event => {
    if (event.target instanceof Element && event.target.closest('.adjustment-reset, .adjustment-category-actions button'))
      preserveAdjustmentNumberFocus(event);
  }}>
    <p className="edit-source-note">{t('workspace.rawPreview.temporary')}</p>
    {settings && bindings.map(({ category, controls, ids }) => <RawCategory key={category} category={category}
      enabled={settings.sections[category === 'basic' ? 'light' : 'color']} disabled={actionsLocked}
      resetDisabled={actionsLocked || category === 'color' && !settings.wb.available}
      onToggle={() => operate({ kind: 'sectionToggle', metadata: { section: category === 'basic' ? 'light' : 'color',
        enabled: !settings.sections[category === 'basic' ? 'light' : 'color'] } })}
      onReset={() => operate({ kind: 'sectionReset', metadata: { section: category === 'basic' ? 'light' : 'color' } })}>
      {category === 'color' && <p className="edit-source-note">{settings.wb.available
        ? `${settings.wb.mode} · Kelvin` : t('workspace.rawPreview.wbUnavailable')}</p>}
      {controls.map((control, index) => {
        const spec = settings.controls.find(spec => spec.id === control)!;
        const id = ids[index];
        const value = raw.desired?.[control] ?? settings.values[control];
        const trackGradient = control === 'wb.temp' ? TEMPERATURE_TRACK_GRADIENT : control === 'wb.tint' ? TINT_TRACK_GRADIENT : undefined;
        const enabled = settings.sections[category === 'basic' ? 'light' : 'color'];
        return <AdjustmentSlider key={`${raw.assetId}:${control}`} adjustmentId={id} hideToggle
          trackGradient={trackGradient} valueSuffix={control === 'wb.temp' ? 'K' : undefined}
          label={t(`workspace.${id}`)} enabled={enabled} onToggle={() => {}}
          onReset={() => operate({ kind: 'controlReset', metadata: { control } })} onBegin={() => raw.beginControls(control)}
          value={value} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision}
          defaultValue={spec.default} resetLabel={t(control.startsWith('wb.') ? 'workspace.rawPreview.wbResetAsShot' : `workspace.${id}Reset`)} valueLabel={t(`workspace.${id}Value`)}
          valueText={`${value.toFixed(spec.precision)}${control === 'wb.temp' ? ' K' : control === 'light.exposure' ? ' EV' : ''}`}
          disabled={locked || !enabled || control.startsWith('wb.') && !settings.wb.available}
          resetDisabled={actionsLocked || control.startsWith('wb.') && !settings.wb.available}
          onChange={value => raw.changeControls({ [control]: value })} onCommit={() => raw.flushControls(control)} />;
      })}
    </RawCategory>)}
    {raw.regenerating && <p role="status">{t('workspace.rawPreview.regenerating')}</p>}
    {raw.regenerationError && <div role="alert"><p>{t('workspace.rawPreview.regenerationFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.regenerating}
        onClick={raw.retryRegeneration}>{t('workspace.rawPreview.retryRegeneration')}</button></div>}
    {raw.saveError && <div role="alert"><p>{t(raw.saveError === 'raw_recipe_revision_conflict'
      ? 'workspace.rawPreview.saveConflict' : 'workspace.rawPreview.saveFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.regenerating || raw.saving}
        onClick={() => { void raw.retrySave(); }}>{t('workspace.rawPreview.retrySave')}</button></div>}
    {raw.editError && <div role="alert"><p>{t('workspace.rawPreview.editFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.locked}
        onClick={raw.retryControls}>{t('workspace.rawPreview.retry')}</button></div>}
  </div>;
}

function RawCategory({ category, enabled, disabled, resetDisabled, onToggle, onReset, children }: {
  category: RawCategoryId; enabled: boolean; disabled: boolean; resetDisabled: boolean;
  onToggle: () => void; onReset: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const title = t(category === 'color' ? 'workspace.rawPreview.colorCategory' : `workspace.${category}`);
  const titleKey = category[0].toUpperCase() + category.slice(1);
  return <section className={`adjustment-category raw-adjustment-category${enabled ? '' : ' is-disabled'}`}>
    <div className="adjustment-category-header">
      <h3><button type="button" className="adjustment-category-title" aria-expanded={expanded}
        aria-controls={contentId} aria-label={t(`workspace.${expanded ? 'collapse' : 'expand'}${titleKey}`)}
        onClick={() => setExpanded(value => !value)} onFocus={focusAdjustmentCategory}
        onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>
        <span className="adjustment-category-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="adjustment-category-label">{title}</span>
      </button></h3>
      <div className="adjustment-category-actions">
        <button type="button" className={`adjustment-category-icon${enabled ? '' : ' is-off'}`} disabled={disabled}
          aria-pressed={enabled} onClick={onToggle} aria-label={t(`workspace.${enabled ? 'disable' : 'enable'}${titleKey}`)}
          title={t(`workspace.${enabled ? 'disable' : 'enable'}${titleKey}`)} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>⏻</button>
        <button type="button" className="adjustment-category-reset" disabled={resetDisabled} onClick={onReset}
          aria-label={t('workspace.resetCategory')} title={t('workspace.resetCategory')} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>{t('workspace.reset')}</button>
      </div>
    </div>
    {expanded && <div id={contentId} className="adjustment-category-content">{children}</div>}
  </section>;
}
