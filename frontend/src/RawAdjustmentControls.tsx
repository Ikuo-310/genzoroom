import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { commitAdjustmentEdits, focusAdjustmentCategory, navigateAdjustments, preserveAdjustmentNumberFocus,
  preservePendingAdjustmentFocus, restorePendingAdjustmentFocus } from './adjustmentFocus';
import type { SliderAdjustmentId } from './adjustmentSliderIds';
import { TINT_TRACK_GRADIENT, TEMPERATURE_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
import { RAW_VIGNETTE_STYLES, type RawControlId, type RawHistoryControlId, type RawHistoryOperation, type RawOpticsFlagId, type RawSectionId, type RawVignetteStyle } from './rawApi';
import type { useRawDocument } from './useRawDocument';

type RawCategoryId = 'basic' | 'color' | 'grading' | 'effects' | 'detail';
const sections: Record<RawCategoryId, RawSectionId> = { basic: 'light', color: 'color', grading: 'grading', effects: 'effects', detail: 'detail' };
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
  { category: 'grading', controls: [], ids: [] },
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
  const [gradingBand, setGradingBand] = useState<'shadows' | 'midtones' | 'highlights'>('shadows');
  const panel = useRef<HTMLDivElement>(null);
  const operate = (operation: RawHistoryOperation) => {
    if (panel.current) commitAdjustmentEdits(panel.current);
    raw.operate(operation);
  };
  const locked = disabled || !!raw.locked || !!raw.editError || raw.status !== 'ready';
  const actionsLocked = locked || !!raw.historyLoading || !!raw.historyError || !raw.history;
  useEffect(() => { if (!actionsLocked && panel.current) restorePendingAdjustmentFocus(panel.current); }, [actionsLocked]);
  return <div className="raw-adjustment-controls" ref={panel} onPointerDownCapture={event => {
    if (event.target instanceof Element && event.target.closest('.adjustment-reset, .adjustment-category-actions button, .raw-adjustment-subsection-header button, .raw-vignette-mode label, .raw-grading-band label'))
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
      {category === 'grading' && <div className="binary-radio-choice raw-grading-band" role="radiogroup" aria-label={t('workspace.rawPreview.gradingBand')}
        onKeyDown={event => navigateAdjustments(event.nativeEvent, event.target as HTMLElement)}>
        <div className="binary-radio-options">
          {(['shadows', 'midtones', 'highlights'] as const).map(band => <label key={band}>
            <input type="radio" name="raw-grading-band" checked={gradingBand === band} disabled={locked}
              onFocus={focusAdjustmentCategory} onChange={event => {
                // Numeric edits can lock the radio before click, and switching unmounts
                // the old band's number input. Restore here only while focus stays in this panel.
                const active = document.activeElement;
                if (active === event.currentTarget || active instanceof HTMLInputElement
                  && active.matches('.adjustment-number') && panel.current?.contains(active))
                  preservePendingAdjustmentFocus(event.currentTarget);
                // Finish edits before unmounting the old band's sliders so History keeps its boundary.
                if (panel.current) commitAdjustmentEdits(panel.current);
                setGradingBand(band);
              }} />
            <span>{t(`workspace.rawPreview.gradingBands.${band}`)}</span>
          </label>)}
        </div>
      </div>}
      <div className={category === 'detail' ? 'raw-detail-controls' : undefined}>{(category === 'grading' ? [`grading.${gradingBand}.hue`, `grading.${gradingBand}.sat`, `grading.${gradingBand}.lum`, 'grading.blending', 'grading.balance'] as RawControlId[] : controls).map((control, index) => {
        const spec = settings.controls.find(spec => spec.id === control)!;
        const id = category === 'grading' ? control : ids[index];
        const value = raw.desired?.[control] ?? settings.values[control];
        const trackGradient = control.startsWith('grading.') && control.endsWith('.hue') ? 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' : control === 'wb.temp' ? TEMPERATURE_TRACK_GRADIENT : control === 'wb.tint' ? TINT_TRACK_GRADIENT : undefined;
        const enabled = settings.sections[sections[category]];
        const dependent = control.startsWith('vignette.') && control !== 'vignette.amount'
          && (raw.desired?.['vignette.amount'] ?? settings.values['vignette.amount']) === 0;
        const labelKey = category === 'grading' ? `rawPreview.${control}` : category === 'detail' || category === 'effects' ? `rawPreview.${vignetteLabels[control] ?? control.split('.')[1]}` : id;
        return <Fragment key={`${raw.assetId}:${control}`}>
          {control === 'vignette.amount' && <>
            <div className="raw-adjustment-subcategory-divider" aria-hidden="true" />
            <RawSubcategoryHeader name={t('workspace.rawPreview.vignette')} disabled={actionsLocked} className="is-vignette"
              onReset={() => operate({ kind: 'sectionReset', metadata: { section: 'vignette' } })} />
            <RawVignetteMode value={settings.vignetteStyle} disabled={actionsLocked || !enabled}
              onReselect={() => { if (panel.current) commitAdjustmentEdits(panel.current); }}
              onChange={style => operate({ kind: 'vignetteStyle', metadata: { style } })} />
          </>}
          {detailHeadings[control] && <h4 className="adjustment-subsection-title">{t(`workspace.rawPreview.${detailHeadings[control]}`)}</h4>}
          <AdjustmentSlider adjustmentId={id} className={dependent ? 'is-dependent-disabled' : undefined}
          commitPolicy="operation-boundary" hideToggle
          trackGradient={trackGradient} valueSuffix={control.endsWith('.hue') ? '°' : control === 'wb.temp' ? 'K' : undefined}
          label={t(`workspace.${labelKey}`)} accessibleLabel={control === 'detail.nrDetail' || control === 'detail.nrColorDetail'
            ? t(`workspace.${labelKey}Name`) : undefined} enabled={enabled} onToggle={() => {}}
          onReset={() => operate({ kind: 'controlReset', metadata: { control } })} onBegin={() => raw.beginControls(control)}
          value={value} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision}
          defaultValue={spec.default} resetLabel={t(control.startsWith('wb.') ? 'workspace.rawPreview.wbResetAsShot' : `workspace.${labelKey}Reset`)} valueLabel={t(`workspace.${labelKey}Value`)}
          valueText={`${value.toFixed(spec.precision)}${control.endsWith('.hue') ? '°' : control === 'wb.temp' ? ' K' : control === 'light.exposure' ? ' EV' : ''}`}
          disabled={locked || !enabled || dependent || control.startsWith('wb.') && !settings.wb.available}
          resetDisabled={actionsLocked || dependent || control.startsWith('wb.') && !settings.wb.available}
          onChange={value => raw.changeControls({ [control]: value })} onCommit={() => raw.flushControls(control)} /></Fragment>;
      })}</div>
      {category === 'detail' && <RawLensCorrections key={raw.assetId} raw={raw} locked={actionsLocked} operate={operate} />}
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

function RawSubcategoryHeader({ name, disabled, onReset, className = '' }: { name: string; disabled: boolean; onReset: () => void; className?: string }) {
  const { t } = useTranslation();
  return <div className={`raw-adjustment-subsection-header ${className}`}>
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
  return <section className={`adjustment-category raw-adjustment-category is-${category}${enabled ? '' : ' is-disabled'}`}>
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

function RawLensCorrections({ raw, locked, operate }: {
  raw: NonNullable<ReturnType<typeof useRawDocument>>; locked: boolean; operate: (operation: RawHistoryOperation) => void;
}) {
  const { t } = useTranslation();
  const settings = raw.settings!;
  const [defringeOpen, setDefringeOpen] = useState(false);
  const baseDisabled = locked || !settings.sections.optics;
  const info = settings.lensProfileInfo;
  const profileUnavailable = info.profileAvailable === false;
  const profileStatus = info.profileSource === 'file' ? t('workspace.rawPreview.profileSourceFile')
    : info.profileSource === 'database' ? t('workspace.rawPreview.profileSourceDatabase')
      : info.profileSource === 'none' ? t('workspace.rawPreview.profileMissing')
        : t('workspace.rawPreview.profileUnknown');
  const value = (control: RawHistoryControlId) => raw.desired?.[control] ?? settings.values[control];
  const slider = (control: Extract<RawHistoryControlId, `optics.${string}`>, key: string, dependent = false, gradient?: string) => {
    const spec = settings.controls.find(item => item.id === control)!;
    return <AdjustmentSlider key={control} adjustmentId={control} commitPolicy="operation-boundary" hideToggle
      className={dependent ? 'is-dependent-disabled' : undefined} trackGradient={gradient}
      valueSuffix={control.includes('Hue') ? '°' : undefined}
      label={t(`workspace.rawPreview.${key}`)} enabled={settings.sections.optics} onToggle={() => {}}
      onReset={() => operate({ kind: 'controlReset', metadata: { control } })} onBegin={() => raw.beginControls(control)}
      value={value(control)} min={spec.min} max={spec.max} step={spec.step} precision={spec.precision} defaultValue={spec.default}
      resetLabel={t(`workspace.rawPreview.${key}Reset`)} valueLabel={t(`workspace.rawPreview.${key}Value`)}
      valueText={`${value(control).toFixed(spec.precision)}${control.includes('Hue') ? '°' : ''}`}
      disabled={baseDisabled || dependent || control.startsWith('optics.profile') && profileUnavailable}
      resetDisabled={locked || dependent || control.startsWith('optics.profile') && profileUnavailable}
      onChange={next => raw.changeControls({ [control]: next })} onCommit={() => raw.flushControls(control)} />;
  };
  const flag = (id: RawOpticsFlagId, key: string, checked: boolean) => <div className="raw-optics-flag-row" key={id}>
    <label className="raw-optics-flag"><input type="checkbox" checked={checked} disabled={locked || !settings.sections.optics}
      onChange={event => operate({ kind: 'opticsFlag', metadata: { control: id, enabled: event.currentTarget.checked } })} />
      <span>{t(`workspace.rawPreview.${key}`)}</span></label>
    <button className="adjustment-reset" type="button" disabled={locked}
      onClick={() => operate({ kind: 'opticsFlagReset', metadata: { control: id } })}
      aria-label={t(`workspace.rawPreview.${key}Reset`)} title={t(`workspace.rawPreview.${key}Reset`)}>{t('workspace.reset')}</button>
  </div>;
  const purpleHue = 'linear-gradient(to right, #777 0%, #ad65bd 25%, #8756b4 55%, #ce75bf 82%, #777 100%)';
  const greenHue = 'linear-gradient(to right, #777 0%, #8bb548 25%, #40ad76 55%, #9dbd52 82%, #777 100%)';
  return <div className="raw-optics-panel" aria-label={t('workspace.rawPreview.lensCorrections')}>
    <div className="raw-adjustment-subcategory-divider" aria-hidden="true" />
    <div className="raw-optics-header">
      <h4>{t('workspace.rawPreview.lensCorrections')}</h4>
      <button type="button" className={`adjustment-category-icon${settings.sections.optics ? '' : ' is-off'}`}
        disabled={locked} aria-pressed={settings.sections.optics}
        aria-label={t(`workspace.rawPreview.${settings.sections.optics ? 'disable' : 'enable'}LensCorrections`)}
        title={t(`workspace.rawPreview.${settings.sections.optics ? 'disable' : 'enable'}LensCorrections`)}
        onClick={() => operate({ kind: 'sectionToggle', metadata: { section: 'optics', enabled: !settings.sections.optics } })}>⏻</button>
      <button type="button" className="adjustment-category-reset" disabled={locked}
        aria-label={t('workspace.rawPreview.resetLensCorrections')} title={t('workspace.rawPreview.resetLensCorrections')}
        onClick={() => operate({ kind: 'sectionReset', metadata: { section: 'optics' } })}>{t('workspace.reset')}</button>
    </div>
    <div className="raw-optics-content">
      {flag('optics.remove_ca', 'removeChromaticAberration', settings.opticsFlags.remove_ca)}
      {flag('optics.lens_profile', 'enableProfileCorrections', settings.opticsFlags.lens_profile)}
      <p className="raw-optics-profile-status" role="status">
        {profileStatus}{info.profileName ? ` · ${info.profileName}` : ''}
        {info.profileApplied === true ? ` · ${t('workspace.rawPreview.profileApplied')}`
          : info.profileApplied === false && settings.opticsFlags.lens_profile && !profileUnavailable
            ? ` · ${t('workspace.rawPreview.profileNotApplied')}` : ''}
      </p>
      {settings.opticsFlags.lens_profile && <>
        {profileUnavailable && <p className="raw-optics-unavailable">{t('workspace.rawPreview.profileUnavailable')}</p>}
        {slider('optics.profileDistortion', 'profileDistortion')}
        {slider('optics.profileVignetting', 'profileVignetting')}
      </>}
      <h5 className="adjustment-subsection-title">{t('workspace.rawPreview.manual')}</h5>
      {slider('optics.distortion', 'opticsDistortion')}
      {slider('optics.vignetting', 'opticsVignetting')}
      {slider('optics.vignettingMidpoint', 'vignettingMidpoint', value('optics.vignetting') === 0)}
      <div className="raw-optics-fold-header">
        <button type="button" className="adjustment-category-title" aria-expanded={defringeOpen}
          onClick={() => setDefringeOpen(open => !open)} onFocus={focusAdjustmentCategory}
          onKeyDown={event => navigateAdjustments(event.nativeEvent, event.currentTarget)}>
          <span className="adjustment-category-chevron" aria-hidden="true">{defringeOpen ? '▾' : '▸'}</span>
          <span>{t('workspace.rawPreview.defringe')}</span>
        </button>
      </div>
      {defringeOpen && <>
        <h5 className="adjustment-subsection-title raw-optics-color-heading is-purple">{t('workspace.rawPreview.purple')}</h5>
        {slider('optics.defringePurple', 'purpleAmount')}
        {slider('optics.defringePurpleHueLo', 'purpleHueLo', value('optics.defringePurple') <= 0, purpleHue)}
        {slider('optics.defringePurpleHueHi', 'purpleHueHi', value('optics.defringePurple') <= 0, purpleHue)}
        <h5 className="adjustment-subsection-title raw-optics-color-heading is-green">{t('workspace.rawPreview.green')}</h5>
        {slider('optics.defringeGreen', 'greenAmount')}
        {slider('optics.defringeGreenHueLo', 'greenHueLo', value('optics.defringeGreen') <= 0, greenHue)}
        {slider('optics.defringeGreenHueHi', 'greenHueHi', value('optics.defringeGreen') <= 0, greenHue)}
        <h5 className="adjustment-subsection-title">{t('workspace.rawPreview.lateralChromaticAberration')}</h5>
        {slider('optics.caRed', 'caRed')}
        {slider('optics.caBlue', 'caBlue')}
      </>}
    </div>
  </div>;
}
