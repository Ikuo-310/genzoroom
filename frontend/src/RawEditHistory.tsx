import { useTranslation } from 'react-i18next';
import { HistoryList } from './HistoryList';
import type { useRawDocument } from './useRawDocument';
import { formatContrast, formatExposure, formatHighlights, formatShadows, formatWhites,
  formatBlacks, formatTint, formatTemperature, formatVibrance, formatSaturation } from './editing';
import type { RawControlId, RawHistoryStep } from './rawApi';

const labels: Record<RawControlId, string> = { 'wb.temp': 'temperature', 'wb.tint': 'tint', 'light.exposure': 'exposure', 'light.contrast': 'contrast',
  'light.highlights': 'highlights', 'light.whites': 'whites', 'light.shadows': 'shadows', 'light.blacks': 'blacks',
  'color.vibrance': 'vibrance', 'color.saturation': 'saturation',
  'effects.texture': 'rawPreview.texture', 'effects.clarity': 'rawPreview.clarity', 'effects.dehaze': 'rawPreview.dehaze',
  'detail.sharpenAmount': 'rawPreview.sharpenAmount', 'detail.sharpenMasking': 'rawPreview.sharpenMasking',
  'detail.nrLuminance': 'rawPreview.nrLuminance', 'detail.nrDetail': 'rawPreview.nrDetailName',
  'detail.nrColor': 'rawPreview.nrColor', 'detail.nrColorDetail': 'rawPreview.nrColorDetailName',
  'detail.nrColorSmoothness': 'rawPreview.nrColorSmoothness' } as const;
const formatters: Record<RawControlId, (value: number) => string> = { 'wb.temp': value => `${Math.round(value)} K`, 'wb.tint': formatTint,
  'light.exposure': formatExposure, 'light.contrast': formatContrast, 'light.highlights': formatHighlights, 'light.whites': formatWhites,
  'light.shadows': formatShadows, 'light.blacks': formatBlacks, 'color.vibrance': formatVibrance, 'color.saturation': formatSaturation,
  'effects.texture': value => value.toFixed(0), 'effects.clarity': value => value.toFixed(0), 'effects.dehaze': value => value.toFixed(0),
  'detail.sharpenAmount': value => value.toFixed(0), 'detail.sharpenMasking': value => value.toFixed(0),
  'detail.nrLuminance': value => value.toFixed(0), 'detail.nrDetail': value => value.toFixed(0),
  'detail.nrColor': value => value.toFixed(0), 'detail.nrColorDetail': value => value.toFixed(0),
  'detail.nrColorSmoothness': value => value.toFixed(0) };

function describe(step: RawHistoryStep, t: ReturnType<typeof useTranslation>['t']) {
  const control = step.metadata.control;
  const reset = step.kind === 'controlReset';
  const name = (id: RawControlId) => t(`workspace.${labels[id]}`);
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
    : t(step.metadata.section === 'effects' ? step.kind === 'sectionReset' ? 'workspace.rawPreview.basicEffects' : 'workspace.rawPreview.effectsCategory'
      : step.metadata.section === 'light' ? 'workspace.basic' : step.metadata.section === 'detail'
      ? 'workspace.rawPreview.detailCategory' : 'workspace.rawPreview.colorCategory')
      + ' ' + t(step.kind === 'sectionToggle' ? step.metadata.enabled ? 'workspace.basicOn' : 'workspace.basicOff' : 'workspace.reset');
  const changes = step.changes;
  return operation + (changes?.length ? `: ${changes.map(change => `${name(change.control)} ${pair(change)}`).join('、')}` : '');
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
    <HistoryList rows={rows} cursor={raw.history?.cursor ?? 0} disabled={disabled || !!raw.locked || !!raw.historyLoading || !!raw.historyError || !raw.history}
      onJump={position => raw.jumpHistory(position === 0 ? null : steps[position - 1].stepId)} />
  </>;
}
