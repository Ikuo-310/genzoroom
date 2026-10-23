import { useTranslation } from 'react-i18next';
import { HistoryList } from './HistoryList';
import type { useRawDocument } from './useRawDocument';
import { formatContrast, formatExposure, formatHighlights, formatShadows, formatWhites,
  formatBlacks, formatTint, formatTemperature, formatVibrance, formatSaturation } from './editing';
import type { RawControlId, RawHistoryStep } from './rawApi';

const labels: Record<RawControlId, string> = { 'wb.temp': 'temperature', 'wb.tint': 'tint', 'light.exposure': 'exposure', 'light.contrast': 'contrast',
  'light.highlights': 'highlights', 'light.whites': 'whites', 'light.shadows': 'shadows', 'light.blacks': 'blacks',
  'color.vibrance': 'vibrance', 'color.saturation': 'saturation' } as const;
const formatters: Record<RawControlId, (value: number) => string> = { 'wb.temp': value => `${Math.round(value)} K`, 'wb.tint': formatTint,
  'light.exposure': formatExposure, 'light.contrast': formatContrast, 'light.highlights': formatHighlights, 'light.whites': formatWhites,
  'light.shadows': formatShadows, 'light.blacks': formatBlacks, 'color.vibrance': formatVibrance, 'color.saturation': formatSaturation };

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
  const operation = step.kind === 'allReset' ? t('workspace.allReset')
    : t(step.metadata.section === 'light' ? 'workspace.basic' : 'workspace.rawPreview.colorCategory')
      + ' ' + t(step.kind === 'sectionToggle' ? step.metadata.enabled ? 'workspace.basicOn' : 'workspace.basicOff' : 'workspace.reset');
  const changes = step.changes;
  return operation + (changes?.length ? `: ${changes.map(change => `${name(change.control)} ${pair(change)}`).join('、')}` : '');
}

export function RawEditHistory({ raw, disabled }: { raw: NonNullable<ReturnType<typeof useRawDocument>>; disabled: boolean }) {
  const { t } = useTranslation();
  const steps = raw.historySteps ?? [], offset = raw.historyOffset ?? 0;
  const rows = steps.map((step, index) => {
    return { id: step.stepId, position: offset + index + 1, description: describe(step, t) };
  });
  return <>
    {raw.history && <p role="status">{t('workspace.rawPreview.historyPosition', { cursor: raw.history.cursor, count: raw.history.length })}</p>}
    {raw.historyLoading && <p role="status">{t('workspace.rawPreview.historyLoading')}</p>}
    {raw.historyError && <div role="alert"><p>{t(raw.historyError === 'raw_history_target_missing'
      ? 'workspace.rawPreview.historyTargetMissing' : 'workspace.rawPreview.historyFailed')}</p>
      <button type="button" className="tool-button" disabled={raw.historyLoading || raw.locked || disabled}
        onClick={() => raw.loadMoreHistory(true)}>{t('workspace.rawPreview.retryHistory')}</button></div>}
    <HistoryList rows={rows} cursor={raw.history?.cursor ?? 0} disabled={disabled || !!raw.locked || !!raw.historyLoading || !!raw.historyError || !raw.history}
      onJump={position => raw.jumpHistory(position === 0 ? null : steps[position - offset - 1].stepId)} />
    {offset > 0 && <button type="button" className="tool-button" disabled={disabled || !!raw.locked || !!raw.dirty || !!raw.historyLoading || !!raw.historyError}
      onClick={() => raw.loadMoreHistory()}>{t('workspace.rawPreview.moreHistory')}</button>}
    {offset + steps.length < (raw.history?.length ?? 0) && <button type="button" className="tool-button"
      disabled={disabled || !!raw.locked || !!raw.dirty || !!raw.historyLoading || !!raw.historyError}
      onClick={() => raw.loadMoreHistory(false, true)}>{t('workspace.rawPreview.newerHistory')}</button>}
  </>;
}
