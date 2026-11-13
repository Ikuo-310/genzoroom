import { useTranslation } from 'react-i18next';
import { HistoryList } from './HistoryList';
import type { useRawDocument } from './useRawDocument';
import { formatContrast, formatExposure, formatHighlights, formatShadows, formatWhites,
  formatBlacks, formatTint, formatVibrance, formatSaturation } from './editing';
import type { RawHistoryControlId, RawOpticsFlagId, RawHistoryStep } from './rawApi';
import { displayTemperature, displayTint } from './rawWhiteBalance';

const mixerColors = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
const mixerFields = ['hue', 'sat', 'lum'] as const;
const mixerLabels = Object.fromEntries(mixerColors.flatMap(color =>
  mixerFields.map(field => [`mixer.${color}.${field}`, `rawPreview.mixer.${field}`]))) as
  Pick<Record<RawHistoryControlId, string>, Extract<RawHistoryControlId, `mixer.${string}`>>;
const mixerFormatters = Object.fromEntries(mixerColors.flatMap(color =>
  mixerFields.map(field => [`mixer.${color}.${field}`, (value: number) => value.toFixed(0)]))) as
  Pick<Record<RawHistoryControlId, (value: number) => string>, Extract<RawHistoryControlId, `mixer.${string}`>>;

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
  ...mixerLabels,
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
  'optics.distortion': 'rawPreview.opticsDistortion', 'optics.vignetting': 'rawPreview.opticsVignetting',
  'optics.vignettingMidpoint': 'rawPreview.vignettingMidpoint',
  'optics.profileDistortion': 'rawPreview.profileDistortion',
  'optics.profileVignetting': 'rawPreview.profileVignetting',
  'optics.defringePurple': 'rawPreview.purpleAmount',
  'optics.defringePurpleHueLo': 'rawPreview.purpleHueLo',
  'optics.defringePurpleHueHi': 'rawPreview.purpleHueHi',
  'optics.defringeGreen': 'rawPreview.greenAmount',
  'optics.defringeGreenHueLo': 'rawPreview.greenHueLo',
  'optics.defringeGreenHueHi': 'rawPreview.greenHueHi',
  'optics.caRed': 'rawPreview.caRed', 'optics.caBlue': 'rawPreview.caBlue' } as const;
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
  ...mixerFormatters,
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
  'optics.remove_ca': 'rawPreview.removeChromaticAberration', 'optics.lens_profile': 'rawPreview.enableProfileCorrections',
  'profile.camera_local_tone': 'rawPreview.cameraLocalTone',
};
const flagResetLabels: Record<RawOpticsFlagId, string> = {
  'optics.remove_ca': 'workspace.rawPreview.removeChromaticAberrationReset',
  'optics.lens_profile': 'workspace.rawPreview.enableProfileCorrectionsReset',
  'profile.camera_local_tone': 'workspace.rawPreview.cameraLocalTone',
};

function describe(step: RawHistoryStep, t: ReturnType<typeof useTranslation>['t'], wbScale: string) {
  if (step.kind === 'geometry') return t(`workspace.rawPreview.cropHistory.${step.metadata.action ?? step.metadata.operation}`);
  if (step.kind === 'curve') return t(`workspace.rawPreview.curveHistory.${step.metadata.channel}`);
  if (step.kind === 'curveReset') {
    const resetLabel = step.metadata.channel === 'point' ? 'resetPoint'
      : `reset${String(step.metadata.channel).charAt(0).toUpperCase()}${String(step.metadata.channel).slice(1)}`;
    return t(`workspace.rawPreview.curveHistory.${resetLabel}`);
  }
  if (step.kind === 'vignetteStyle')
    return `${t('workspace.rawPreview.vignetteMode')}: ${t(`workspace.rawPreview.vignetteStyles.${step.metadata.style}`)}`;
  if (step.kind === 'opticsFlag' || step.kind === 'opticsFlagReset') {
    const flag = step.metadata.control as RawOpticsFlagId;
    const label = t(step.kind === 'opticsFlagReset' ? flagResetLabels[flag] : `workspace.${flagLabels[flag]}`);
    const change = step.flagChanges?.find(item => item.control === flag);
    return label + (change ? ` ${t(change.before ? 'workspace.basicOn' : 'workspace.basicOff')} → ${t(change.after ? 'workspace.basicOn' : 'workspace.basicOff')}` : '');
  }
  const control = step.metadata.control as RawHistoryControlId | undefined;
  const reset = step.kind === 'controlReset';
  const name = (id: RawHistoryControlId) => t(`workspace.${labels[id]}`);
  const pair = (change: NonNullable<RawHistoryStep['changes']>[number]) => {
    if (change.control === 'wb.temp') {
      const unit = wbScale === 'legacy' ? '' : ' K';
      return `${Math.round(displayTemperature(change.before, wbScale))}${unit} → ${Math.round(displayTemperature(change.after, wbScale))}${unit}`;
    }
    if (change.control === 'wb.tint' && wbScale === 'legacy')
      return `${formatTint(displayTint(change.before))} → ${formatTint(displayTint(change.after))}`;
    return `${formatters[change.control](change.before)} → ${formatters[change.control](change.after)}`;
  };
  if (control) {
    const label = t(`workspace.${labels[control]}${reset ? 'Reset' : ''}`);
    if (reset && step.changes?.length && (step.changes.length > 1 || step.changes[0].control !== control))
      return `${label}: ${step.changes.map(change => `${name(change.control)} ${pair(change)}`).join('、')}`;
    const change = step.changes?.find(item => item.control === control);
    return label + (change ? ` ${pair(change)}` : '');
  }
  const opticsSection = step.metadata.section === 'optics';
  const operation = step.kind === 'wbPick' ? t('workspace.rawPreview.wbPick') : step.kind === 'wbAuto' ? t('workspace.rawPreview.aw') : step.kind === 'allReset' ? t('workspace.allReset')
    : opticsSection && step.kind === 'sectionReset' ? t('workspace.rawPreview.resetLensCorrections')
      : t(step.metadata.section === 'grading' ? 'workspace.rawPreview.gradingCategory' : step.metadata.section === 'vignette' ? 'workspace.rawPreview.vignette'
      : step.metadata.section === 'effects' ? step.kind === 'sectionReset' ? 'workspace.rawPreview.basicEffects' : 'workspace.rawPreview.effectsCategory'
      : step.metadata.section === 'light' ? 'workspace.basic' : step.metadata.section === 'detail'
      ? 'workspace.rawPreview.detailCategory' : opticsSection ? 'workspace.rawPreview.lensCorrections' : 'workspace.rawPreview.colorCategory')
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
  const rows = steps.map((step, index) => ({ id: step.stepId, position: index + 1,
    description: describe(step, t, raw.settings?.wb.scale ?? 'kelvin') }));
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
