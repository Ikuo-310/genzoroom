import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { commitAdjustmentEdits, focusAdjustmentCategory, navigateAdjustments, preserveAdjustmentNumberFocus,
  preservePendingAdjustmentFocus, restorePendingAdjustmentFocus } from './adjustmentFocus';
import type { SliderAdjustmentId } from './adjustmentSliderIds';
import { TINT_TRACK_GRADIENT, TEMPERATURE_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
import { RAW_VIGNETTE_STYLES, type RawControlId, type RawHistoryOperation, type RawSectionId, type RawVignetteStyle } from './rawApi';
import type { useRawDocument } from './useRawDocument';

type RawCategoryId = 'basic' | 'color' | 'effects' | 'detail';
const sections: Record<RawCategoryId, RawSectionId> = { basic: 'light', color: 'color', effects: 'effects', detail: 'detail' };
const wbErrors: Record<string, string> = {
  raw_wb_no_valid_samples: 'awNoSamples', raw_wb_geometry_mismatch: 'wbGeometryMismatch',
  raw_wb_point_outside_source: 'wbPointOutside', raw_wb_source_unavailable: 'wbSourceUnavailable',
  raw_wb_settings_mismatch: 'wbSettingsMismatch', raw_wb_invalid_response: 'wbInvalidResponse',
  raw_wb_connection_failed: 'wbConnectionFailed', raw_wb_timeout: 'wbTimeout',
};
const bindings: { category: RawCategoryId; controls: RawControlId[]; ids: SliderAdjustmentId[] }[] = [
  { category: 'color', controls: ['wb.temp', 'wb.tint', 'color.vibrance', 'color.saturation'], ids: ['temperature', 'tint', 'vibrance', 'saturation'] },
  { category: 'basic', controls: ['light.exposure', 'light.contrast', 'light.highlights', 'light.whites', 'light.shadows', 'light.blacks'],
    ids: ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] },
  { category: 'effects', controls: ['effects.texture', 'effects.clarity', 'effects.dehaze',
    'vignette.amount', 'vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights'],
    ids: ['effects.texture', 'effects.clarity', 'effects.dehaze',
      'vignette.amount', 'vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights'] },
  { category: 'detail', controls: ['detail.sharpenAmount', 'detail.sharpenMasking', 'detail.nrLuminance', 'detail.nrDetail',
    'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness'],
    ids: ['detail.sharpenAmount', 'detail.sharpenMasking', 'detail.nrLuminance', 'detail.nrDetail',
      'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness'] },
];
const detailHeadings: Partial<Record<RawControlId, string>> = {
  'detail.sharpenAmount': 'sharpening', 'detail.nrLuminance': 'noiseReduction', 'detail.nrColor': 'colorNoiseReduction',
};
const vignetteLabels: Partial<Record<RawControlId, string>> = {
  'vignette.amount': 'vignetteAmount', 'vignette.midpoint': 'vignetteMidpoint', 'vignette.feather': 'vignetteFeather',
  'vignette.roundness': 'vignetteRoundness', 'vignette.highlights': 'vignetteHighlights',
};

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
  useEffect(() => { if (!actionsLocked && panel.current) restorePendingAdjustmentFocus(panel.current); }, [actionsLocked]);
  return <div className="raw-adjustment-controls" ref={panel} onPointerDownCapture={event => {
    if (event.target instanceof Element && event.target.closest('.adjustment-reset, .adjustment-category-actions button, .raw-adjustment-subsection-header button, .raw-vignette-mode label'))
      preserveAdjustmentNumberFocus(event);
  }}>
    <p className="edit-source-note">{t('workspace.rawPreview.temporary')}</p>
    {settings && bindings.map(({ category, controls, ids }) => <RawCategory key={category} category={category}
      enabled={settings.sections[sections[category]]} disabled={actionsLocked}
      resetDisabled={actionsLocked || category === 'color' && !settings.wb.available}
      picker={category === 'color' ? { disabled: actionsLocked || !raw.pickAvailable, active: !!raw.pickActive,
        run: () => { if (panel.current) commitAdjustmentEdits(panel.current); raw.togglePick(); } } : undefined}
      autoWhiteBalance={category === 'color' ? {
        disabled: actionsLocked || !settings.sections.color || !settings.wb.available || !settings.wbAutoAvailable,
        run: () => operate({ kind: 'wbAuto', metadata: {} }),
      } : undefined}
      onToggle={() => operate({ kind: 'sectionToggle', metadata: { section: sections[category],
        enabled: !settings.sections[sections[category]] } })}
      onReset={category === 'effects' ? undefined : () => operate({ kind: 'sectionReset', metadata: { section: sections[category] } })}>
      {category === 'color' && <p className="edit-source-note">{settings.wb.available
        ? `${settings.wb.mode} · Kelvin` : t('workspace.rawPreview.wbUnavailable')}</p>}
      {category === 'effects' && <RawSubcategoryHeader name={t('workspace.rawPreview.basicEffects')}
        disabled={actionsLocked} onReset={() => operate({ kind: 'sectionReset', metadata: { section: 'effects' } })} />}
      {controls.map((control, index) => {
        const spec = settings.controls.find(spec => spec.id === control)!;
        const id = ids[index];
        const value = raw.desired?.[control] ?? settings.values[control];
        const trackGradient = control === 'wb.temp' ? TEMPERATURE_TRACK_GRADIENT : control === 'wb.tint' ? TINT_TRACK_GRADIENT : undefined;
        const enabled = settings.sections[sections[category]];
        const dependent = control.startsWith('vignette.') && control !== 'vignette.amount'
          && (raw.desired?.['vignette.amount'] ?? settings.values['vignette.amount']) === 0;
        const labelKey = category === 'detail' || category === 'effects' ? `rawPreview.${vignetteLabels[control] ?? control.split('.')[1]}` : id;
        return <Fragment key={`${raw.assetId}:${control}`}>
          {control === 'vignette.amount' && <>
            <div className="raw-adjustment-subcategory-divider" aria-hidden="true" />
            <RawSubcategoryHeader name={t('workspace.rawPreview.vignette')} disabled={actionsLocked}
              onReset={() => operate({ kind: 'sectionReset', metadata: { section: 'vignette' } })} />
            <RawVignetteMode value={settings.vignetteStyle} disabled={actionsLocked || !enabled}
              onReselect={() => { if (panel.current) commitAdjustmentEdits(panel.current); }}
              onChange={style => operate({ kind: 'vignetteStyle', metadata: { style } })} />
          </>}
          {detailHeadings[control] && <h4 className="adjustment-subsection-title">{t(`workspace.rawPreview.${detailHeadings[control]}`)}</h4>}
          <AdjustmentSlider adjustmentId={id} className={dependent ? 'is-dependent-disabled' : undefined}
          commitPolicy="operation-boundary" hideToggle
          trackGradient={trackGradient} valueSuffix={control === 'wb.temp' ? 'K' : undefined}
          label={t(`workspace.${labelKey}`)} accessibleLabel={control === 'detail.nrDetail' || control === 'detail.nrColorDetail'
            ? t(`workspace.${labelKey}Name`) : undefined} enabled={enabled} onToggle={() => {}}
          onReset={() => operate({ kind: 'controlReset', metadata: { control } })} onBegin={() => raw.beginControls(control)}
          value={value} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision}
          defaultValue={spec.default} resetLabel={t(control.startsWith('wb.') ? 'workspace.rawPreview.wbResetAsShot' : `workspace.${labelKey}Reset`)} valueLabel={t(`workspace.${labelKey}Value`)}
          valueText={`${value.toFixed(spec.precision)}${control === 'wb.temp' ? ' K' : control === 'light.exposure' ? ' EV' : ''}`}
          disabled={locked || !enabled || dependent || control.startsWith('wb.') && !settings.wb.available}
          resetDisabled={actionsLocked || dependent || control.startsWith('wb.') && !settings.wb.available}
          onChange={value => raw.changeControls({ [control]: value })} onCommit={() => raw.flushControls(control)} /></Fragment>;
      })}
    </RawCategory>)}
    {raw.operationError && <p role="alert">{t(`workspace.rawPreview.${wbErrors[raw.operationError] ?? 'awFailed'}`)}</p>}
    {raw.regenerating && <p role="status">{t('workspace.rawPreview.regenerating')}</p>}
    {raw.regenerationError && <div role="alert"><p>{t('workspace.rawPreview.regenerationFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.regenerating}
        onClick={raw.retryRegeneration}>{t('workspace.rawPreview.retryRegeneration')}</button></div>}
    {raw.saveError && <div role="alert"><p>{t(raw.saveError === 'raw_recipe_revision_conflict'
      ? 'workspace.rawPreview.saveConflict' : 'workspace.rawPreview.saveFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.regenerating || raw.saving}
        onClick={() => { void raw.retrySave(); }}>{t('workspace.rawPreview.retrySave')}</button></div>}
    {raw.displayError && <div role="alert"><p>{t('workspace.rawPreview.error')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.locked}
        onClick={raw.retryPreview}>{t('workspace.rawPreview.retry')}</button></div>}
    {raw.editError && <div role="alert"><p>{t('workspace.rawPreview.editFailed')}</p>
      <button className="tool-button" type="button" disabled={disabled || raw.locked}
        onClick={raw.retryControls}>{t('workspace.rawPreview.retry')}</button></div>}
  </div>;
}

function RawVignetteMode({ value, disabled, onChange, onReselect }: {
  value: RawVignetteStyle; disabled: boolean; onChange: (style: RawVignetteStyle) => void; onReselect: () => void;
}) {
  const { t } = useTranslation();
  const name = useId();
  return <div className="binary-radio-choice raw-vignette-mode" role="radiogroup" aria-label={t('workspace.rawPreview.vignetteMode')}
    onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.target as HTMLElement)}>
    <span>{t('workspace.rawPreview.mode')}</span>
    <div className="binary-radio-options">
      {RAW_VIGNETTE_STYLES.map(style => <label key={style}>
        <input type="radio" name={name} value={style} checked={value === style} disabled={disabled}
          onClick={() => { if (value === style) onReselect(); }} onChange={event => {
          if (style === value) return;
          // The operation lock temporarily disables this radio; retain focus unless the user leaves it.
          if (document.activeElement === event.currentTarget) preservePendingAdjustmentFocus(event.currentTarget);
          onChange(style);
        }} />
        <span>{t(`workspace.rawPreview.vignetteStyles.${style}`)}</span>
      </label>)}
    </div>
  </div>;
}

function RawSubcategoryHeader({ name, disabled, onReset }: { name: string; disabled: boolean; onReset: () => void }) {
  const { t } = useTranslation();
  return <div className="raw-adjustment-subsection-header">
    <h4 className="adjustment-subsection-title raw-adjustment-subsection-title" tabIndex={0}
      onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>{name}</h4>
    <button type="button" className="adjustment-category-reset" disabled={disabled} onClick={onReset}
      aria-label={t('workspace.rawPreview.resetSubcategory', { name })} title={t('workspace.rawPreview.resetSubcategory', { name })}
      onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>{t('workspace.reset')}</button>
  </div>;
}

function RawCategory({ category, enabled, disabled, resetDisabled, autoWhiteBalance, picker, onToggle, onReset, children }: {
  category: RawCategoryId; enabled: boolean; disabled: boolean; resetDisabled: boolean;
  onToggle: () => void; onReset?: () => void; children: ReactNode;
  picker?: { disabled: boolean; active: boolean; run: () => void };
  autoWhiteBalance?: { disabled: boolean; run: () => void };
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const title = t(category === 'basic' ? 'workspace.basic' : `workspace.rawPreview.${category}Category`);
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
        {autoWhiteBalance && <button type="button" className="adjustment-category-icon raw-auto-wb" data-category-command disabled={autoWhiteBalance.disabled}
          onClick={autoWhiteBalance.run} aria-label={t('workspace.rawPreview.aw')} title={t('workspace.rawPreview.aw')}
          onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>AW</button>}
        {picker && <button type="button" className={`adjustment-category-icon raw-wb-pick${picker.active ? ' is-selected' : ''}`}
          data-category-command disabled={picker.disabled} aria-pressed={picker.active}
          aria-label={t('workspace.rawPreview.wbPick')} title={t('workspace.rawPreview.wbPick')}
          onClick={picker.run} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m14 5 5 5M16 3l5 5-3 3-1-1-10 10-4 1 1-4L14 7l-1-1z" />
          </svg>
        </button>}
        <button type="button" className={`adjustment-category-icon${enabled ? '' : ' is-off'}`} data-category-switch disabled={disabled}
          aria-pressed={enabled} onClick={onToggle} aria-label={t(`workspace.${enabled ? 'disable' : 'enable'}${titleKey}`)}
          title={t(`workspace.${enabled ? 'disable' : 'enable'}${titleKey}`)} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>⏻</button>
        {onReset && <button type="button" className="adjustment-category-reset" disabled={resetDisabled} onClick={onReset}
          aria-label={t('workspace.resetCategory')} title={t('workspace.resetCategory')} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>{t('workspace.reset')}</button>}
      </div>
    </div>
    {expanded && <div id={contentId} className="adjustment-category-content">{children}</div>}
  </section>;
}
