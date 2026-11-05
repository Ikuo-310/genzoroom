import { useTranslation } from 'react-i18next';
import { HistoryList } from './HistoryList';
import type { useRawDocument } from './useRawDocument';
import { formatContrast, formatExposure, formatHighlights, formatShadows, formatWhites,
  formatBlacks, formatTint, formatTemperature, formatVibrance, formatSaturation } from './editing';
import type { RawHistoryControlId, RawOpticsFlagId, RawHistoryStep } from './rawApi';

const labels: Record<RawHistoryControlId, string> = {
  'grading.shadows.hue': 'rawPreview.grading.shadows.hue',
  'grading.shadows.sat': 'rawPreview.grading.shadows.sat',
  'grading.shadows.lum': 'rawPreview.grading.shadows.lum',
  'grading.midtones.hue': 'rawPreview.grading.midtones.hue',
  'grading.midtones.sat': 'rawPreview.grading.midtones.sat',
  'grading.midtones.lum': 'rawPreview.grading.midtones.lum',
  'grading.highlights.hue': 'rawPreview.grading.highlights.hue',
  'grading.highlights.sat': 'rawPreview.grading.highlights.sat',
  'grading.highlights.lum': 'rawPreview.grading.highlights.lum',
  'grading.blending': 'rawPreview.grading.blending',
  'grading.balance': 'rawPreview.grading.balance',
 'wb.temp': 'temperature', 'wb.tint': 'tint', 'light.exposure': 'exposure', 'light.contrast': 'contrast',
  'light.highlights': 'highlights', 'light.whites': 'whites', 'light.shadows': 'shadows', 'light.blacks': 'blacks',
  'color.vibrance': 'vibrance', 'color.saturation': 'saturation',
  'effects.texture': 'rawPreview.texture', 'effects.clarity': 'rawPreview.clarity', 'effects.dehaze': 'rawPreview.dehaze',
  'vignette.amount': 'rawPreview.vignetteAmount', 'vignette.midpoint': 'rawPreview.vignetteMidpoint',
  'vignette.feather': 'rawPreview.vignetteFeather', 'vignette.roundness': 'rawPreview.vignetteRoundness',
  'vignette.highlights': 'rawPreview.vignetteHighlights',
  'detail.sharpenAmount': 'rawPreview.sharpenAmount', 'detail.sharpenMasking': 'rawPreview.sharpenMasking',
  'detail.nrLuminance': 'rawPreview.nrLuminance', 'detail.nrDetail': 'rawPreview.nrDetailName',
  'detail.nrColor': 'rawPreview.nrColor', 'detail.nrColorDetail': 'rawPreview.nrColorDetailName',
  'detail.nrColorSmoothness': 'rawPreview.nrColorSmoothness',
  'optics.distortion': 'rawPreview.opticsControls.distortion', 'optics.vignetting': 'rawPreview.opticsControls.vignetting',
  'optics.vignettingMidpoint': 'rawPreview.opticsControls.vignettingMidpoint',
  'optics.profileDistortion': 'rawPreview.opticsControls.profileDistortion',
  'optics.profileVignetting': 'rawPreview.opticsControls.profileVignetting',
  'optics.defringePurple': 'rawPreview.opticsControls.defringePurple',
  'optics.defringePurpleHueLo': 'rawPreview.opticsControls.defringePurpleHueLo',
  'optics.defringePurpleHueHi': 'rawPreview.opticsControls.defringePurpleHueHi',
  'optics.defringeGreen': 'rawPreview.opticsControls.defringeGreen',
  'optics.defringeGreenHueLo': 'rawPreview.opticsControls.defringeGreenHueLo',
  'optics.defringeGreenHueHi': 'rawPreview.opticsControls.defringeGreenHueHi',
  'optics.caRed': 'rawPreview.opticsControls.caRed', 'optics.caBlue': 'rawPreview.opticsControls.caBlue' } as const;
const formatters: Record<RawHistoryControlId, (value: number) => string> = {
  'grading.shadows.hue': value => value.toFixed(0) + '°',
  'grading.shadows.sat': value => value.toFixed(0),
  'grading.shadows.lum': value => value.toFixed(0),
  'grading.midtones.hue': value => value.toFixed(0) + '°',
  'grading.midtones.sat': value => value.toFixed(0),
  'grading.midtones.lum': value => value.toFixed(0),
  'grading.highlights.hue': value => value.toFixed(0) + '°',
  'grading.highlights.sat': value => value.toFixed(0),
  'grading.highlights.lum': value => value.toFixed(0),
  'grading.blending': value => value.toFixed(0),
  'grading.balance': value => value.toFixed(0),
 'wb.temp': value => `${Math.round(value)} K`, 'wb.tint': formatTint,
  'light.exposure': formatExposure, 'light.contrast': formatContrast, 'light.highlights': formatHighlights, 'light.whites': formatWhites,
  'light.shadows': formatShadows, 'light.blacks': formatBlacks, 'color.vibrance': formatVibrance, 'color.saturation': formatSaturation,
  'effects.texture': value => value.toFixed(0), 'effects.clarity': value => value.toFixed(0), 'effects.dehaze': value => value.toFixed(0),
  'vignette.amount': value => value.toFixed(0), 'vignette.midpoint': value => value.toFixed(0),
  'vignette.feather': value => value.toFixed(0), 'vignette.roundness': value => value.toFixed(0), 'vignette.highlights': value => value.toFixed(0),
  'detail.sharpenAmount': value => value.toFixed(0), 'detail.sharpenMasking': value => value.toFixed(0),
  'detail.nrLuminance': value => value.toFixed(0), 'detail.nrDetail': value => value.toFixed(0),
  'detail.nrColor': value => value.toFixed(0), 'detail.nrColorDetail': value => value.toFixed(0),
  'detail.nrColorSmoothness': value => value.toFixed(0),
  'optics.distortion': value => value.toFixed(0), 'optics.vignetting': value => value.toFixed(0),
  'optics.vignettingMidpoint': value => value.toFixed(0), 'optics.profileDistortion': value => value.toFixed(0),
  'optics.profileVignetting': value => value.toFixed(0), 'optics.defringePurple': value => value.toFixed(0),
  'optics.defringePurpleHueLo': value => value.toFixed(0), 'optics.defringePurpleHueHi': value => value.toFixed(0),
  'optics.defringeGreen': value => value.toFixed(0), 'optics.defringeGreenHueLo': value => value.toFixed(0),
  'optics.defringeGreenHueHi': value => value.toFixed(0), 'optics.caRed': value => value.toFixed(0),
  'optics.caBlue': value => value.toFixed(0) };
const flagLabels: Record<RawOpticsFlagId, string> = {
  'optics.remove_ca': 'rawPreview.opticsControls.removeCa', 'optics.lens_profile': 'rawPreview.opticsControls.lensProfile',
};

function describe(step: RawHistoryStep, t: ReturnType<typeof useTranslation>['t']) {
  if (step.kind === 'geometry') return t(`workspace.rawPreview.cropHistory.${step.metadata.action ?? step.metadata.operation}`);
  if (step.kind === 'vignetteStyle')
    return `${t('workspace.rawPreview.vignetteMode')}: ${t(`workspace.rawPreview.vignetteStyles.${step.metadata.style}`)}`;
  if (step.kind === 'opticsFlag' || step.kind === 'opticsFlagReset') {
    const flag = step.metadata.control as RawOpticsFlagId, label = t(`workspace.${flagLabels[flag]}`);
    const change = step.flagChanges?.find(item => item.control === flag);
    return label + (step.kind === 'opticsFlagReset' ? ` ${t('workspace.reset')}` : '')
      + (change ? ` ${t(change.before ? 'workspace.basicOn' : 'workspace.basicOff')} → ${t(change.after ? 'workspace.basicOn' : 'workspace.basicOff')}` : '');
  }
  const control = step.metadata.control as RawHistoryControlId | undefined;
  const reset = step.kind === 'controlReset';
  const name = (id: RawHistoryControlId) => t(`workspace.${labels[id]}`);
  const pair = (change: NonNullable<RawHistoryStep['changes']>[number]) =>
    `${formatters[change.control](change.before)} → ${formatters[change.control](change.after)}`;
  if (control) {
    const label = t(`workspace.${labels[control]}${reset ? 'Reset' : ''}`);
    if (reset && step.changes?.length && (step.changes.length > 1 || step.changes[0].control !== control))
      return `${label}: ${step.changes.map(change => `${name(change.control)} ${pair(change)}`).join('、')}`;
    const change = step.changes?.find(item => item.control === control);
    return label + (change ? ` ${pair(change)}` : '');
  }
  const operation = step.kind === 'wbPick' ? t('workspace.rawPreview.wbPick') : step.kind === 'wbAuto' ? t('workspace.rawPreview.aw') : step.kind === 'allReset' ? t('workspace.allReset')
    : t(step.metadata.section === 'grading' ? 'workspace.rawPreview.gradingCategory' : step.metadata.section === 'vignette' ? 'workspace.rawPreview.vignette'
      : step.metadata.section === 'effects' ? step.kind === 'sectionReset' ? 'workspace.rawPreview.basicEffects' : 'workspace.rawPreview.effectsCategory'
      : step.metadata.section === 'light' ? 'workspace.basic' : step.metadata.section === 'detail'
      ? 'workspace.rawPreview.detailCategory' : step.metadata.section === 'optics' ? 'workspace.rawPreview.opticsCategory' : 'workspace.rawPreview.colorCategory')
      + ' ' + t(step.kind === 'sectionToggle' ? step.metadata.enabled ? 'workspace.basicOn' : 'workspace.basicOff' : 'workspace.reset');
  const changes = step.changes;
  const numeric = changes?.map(change => `${name(change.control)} ${pair(change)}`) ?? [];
  const flags = step.flagChanges?.map(change => `${t(`workspace.${flagLabels[change.control]}`)} ${t(change.before ? 'workspace.basicOn' : 'workspace.basicOff')} → ${t(change.after ? 'workspace.basicOn' : 'workspace.basicOff')}`) ?? [];
  const details = [...numeric, ...flags];
  return operation + (details.length ? `: ${details.join('、')}` : '');
}

export function RawEditHistory({ raw, disabled, onReset }: { raw: NonNullable<ReturnType<typeof useRawDocument>>; disabled: boolean;
  onReset: (trigger: HTMLElement) => void }) {
  const { t } = useTranslation();
  const steps = raw.historySteps ?? [];
  const rows = steps.map((step, index) => ({ id: step.stepId, position: index + 1, description: describe(step, t) }));
  return <>
    {raw.resetError && <p role="alert">{t(raw.resetError === 'raw_edit_reset_database_failed' ? 'workspace.rawPreview.editResetDatabaseFailed'
      : raw.resetError === 'raw_edit_reset_session_failed' ? 'workspace.rawPreview.editResetSessionFailed'
        : raw.resetError === 'raw_edit_reset_reopen_failed' ? 'workspace.rawPreview.editResetReopenFailed'
          : 'workspace.rawPreview.editResetFailed')}</p>}
    <button type="button" className="tool-button" disabled={disabled || !!raw.resetting}
      onClick={event => onReset(event.currentTarget)}>{t('workspace.rawPreview.editReset')}</button>
    {raw.history && <p role="status">{t('workspace.rawPreview.historyPosition', { cursor: raw.history.cursor, count: raw.history.length })}</p>}
    {raw.historyLoading && <p role="status">{t('workspace.rawPreview.historyLoading')}</p>}
    {raw.historyError && <div role="alert"><p>{t(raw.historyError === 'raw_history_target_missing'
      ? 'workspace.rawPreview.historyTargetMissing' : 'workspace.rawPreview.historyFailed')}</p>
      <button type="button" className="tool-button" disabled={raw.historyLoading || raw.locked || disabled}
        onClick={() => raw.retryHistory()}>{t('workspace.rawPreview.retryHistory')}</button></div>}
    <HistoryList rows={rows} cursor={raw.history?.cursor ?? 0} disabled={disabled || !!raw.locked && !(raw.crop?.operation === 'straighten' && !raw.saveError) || !!raw.historyLoading || !!raw.historyError || !raw.history}
      onJump={position => raw.jumpHistory(position === 0 ? null : steps[position - 1].stepId)} />
  </>;
}
