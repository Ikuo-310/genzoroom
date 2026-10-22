import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { focusAdjustmentCategory, navigateAdjustments } from './adjustmentFocus';
import type { AdjustmentId } from './editing';
import { TINT_TRACK_GRADIENT, TEMPERATURE_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
import type { RawControlId } from './rawApi';
import type { useRawDocument } from './useRawDocument';

type RawCategoryId = 'whiteBalance' | 'basic' | 'color';
const bindings: { category: RawCategoryId; controls: RawControlId[]; ids: AdjustmentId[] }[] = [
  { category: 'whiteBalance', controls: ['wb.temp', 'wb.tint'], ids: ['temperature', 'tint'] },
  { category: 'basic', controls: ['light.exposure', 'light.contrast', 'light.highlights', 'light.whites', 'light.shadows', 'light.blacks'],
    ids: ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] },
  { category: 'color', controls: ['color.vibrance', 'color.saturation'], ids: ['vibrance', 'saturation'] },
];

export function RawAdjustmentControls({ raw, disabled = false }: { raw: NonNullable<ReturnType<typeof useRawDocument>>; disabled?: boolean }) {
  const { t } = useTranslation();
  const settings = raw.settings;
  const actionsUnavailable = t('workspace.rawPreview.actionsUnavailable');
  return <div className="raw-adjustment-controls">
    <p className="edit-source-note">{t('workspace.rawPreview.temporary')}</p>
    {raw.regenerating && <p role="status">{t('workspace.rawPreview.regenerating')}</p>}
    {raw.regenerationError && <div role="alert"><p>{t('workspace.rawPreview.regenerationFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.regenerating}
        onClick={raw.retryRegeneration}>{t('workspace.rawPreview.retryRegeneration')}</button></div>}
    {raw.saving && <p role="status">{t('workspace.rawPreview.saving')}</p>}
    {raw.dirty && !raw.saving && !raw.saveError && <p role="status">{t('workspace.rawPreview.unsaved')}</p>}
    {raw.saveError && <div role="alert"><p>{t(raw.saveError === 'raw_recipe_revision_conflict'
      ? 'workspace.rawPreview.saveConflict' : 'workspace.rawPreview.saveFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.locked}
        onClick={() => { void raw.retrySave(); }}>{t('workspace.rawPreview.retrySave')}</button></div>}
    {raw.pending && !raw.editError && <p role="status">{t('workspace.rawPreview.updating')}</p>}
    {raw.editError && <div role="alert"><p>{t('workspace.rawPreview.editFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.locked}
        onClick={raw.retryControls}>{t('workspace.rawPreview.retry')}</button></div>}
    {settings && bindings.map(({ category, controls, ids }) => <RawCategory key={category} category={category} unavailableLabel={actionsUnavailable}>
      {category === 'whiteBalance' && <p className="edit-source-note">{settings.wb.available
        ? `${settings.wb.mode} · Kelvin` : t('workspace.rawPreview.wbUnavailable')}</p>}
      {controls.map((control, index) => {
        const spec = settings.controls.find(spec => spec.id === control)!;
        const id = ids[index];
        const value = raw.desired?.[control] ?? settings.values[control];
        const trackGradient = control === 'wb.temp' ? TEMPERATURE_TRACK_GRADIENT : control === 'wb.tint' ? TINT_TRACK_GRADIENT : undefined;
        // C4 owns RAW bypass and reset semantics; disabled placeholders keep the JPEG panel layout consistent.
        return <AdjustmentSlider key={`${raw.assetId}:${control}`} adjustmentId={id} actionsDisabled
          actionsUnavailableLabel={actionsUnavailable} trackGradient={trackGradient}
          label={t(`workspace.${id}`)} enabled onToggle={() => {}} onReset={() => {}} onBegin={raw.beginControls}
          value={value} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision}
          defaultValue={spec.default} resetLabel={t(`workspace.${id}Reset`)} valueLabel={t(`workspace.${id}Value`)}
          valueText={`${value.toFixed(spec.precision)}${control === 'wb.temp' ? ' K' : control === 'light.exposure' ? ' EV' : ''}`}
          disabled={disabled || raw.locked || !!raw.editError || raw.status !== 'ready' || control.startsWith('wb.') && !settings.wb.available}
          onChange={value => raw.changeControls({ [control]: value })} onCommit={raw.flushControls} />;
      })}
    </RawCategory>)}
  </div>;
}

function RawCategory({ category, unavailableLabel, children }: { category: RawCategoryId; unavailableLabel: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const title = t(`workspace.${category}`);
  const titleKey = category[0].toUpperCase() + category.slice(1);
  return <section className="adjustment-category raw-adjustment-category">
    <div className="adjustment-category-header">
      <h3><button type="button" className="adjustment-category-title" aria-expanded={expanded}
        aria-controls={contentId} aria-label={t(`workspace.${expanded ? 'collapse' : 'expand'}${titleKey}`)}
        onClick={() => setExpanded(value => !value)} onFocus={focusAdjustmentCategory}
        onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>
        <span className="adjustment-category-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="adjustment-category-label">{title}</span>
      </button></h3>
      <div className="adjustment-category-actions" title={unavailableLabel}>
        <button type="button" className="adjustment-category-icon raw-action-unavailable" disabled
          aria-label={unavailableLabel} title={unavailableLabel} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>⏻</button>
        <button type="button" className="adjustment-category-reset raw-action-unavailable" disabled
          aria-label={unavailableLabel} title={unavailableLabel} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>{t('workspace.reset')}</button>
      </div>
    </div>
    {expanded && <div id={contentId} className="adjustment-category-content">{children}</div>}
  </section>;
}
