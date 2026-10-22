import { useTranslation } from 'react-i18next';
import { HistoryList } from './HistoryList';
import type { useRawDocument } from './useRawDocument';

const labels = { 'wb.temp': 'temperature', 'wb.tint': 'tint', 'light.exposure': 'exposure', 'light.contrast': 'contrast',
  'light.highlights': 'highlights', 'light.whites': 'whites', 'light.shadows': 'shadows', 'light.blacks': 'blacks',
  'color.vibrance': 'vibrance', 'color.saturation': 'saturation' } as const;

export function RawEditHistory({ raw, disabled }: { raw: NonNullable<ReturnType<typeof useRawDocument>>; disabled: boolean }) {
  const { t } = useTranslation();
  const steps = raw.historySteps ?? [], offset = raw.historyOffset ?? 0;
  const rows = steps.map((step, index) => {
    const control = step.metadata.control;
    const description = control ? t(`workspace.${labels[control]}${step.kind === 'controlReset' ? 'Reset' : ''}`)
      + (control === 'wb.temp' ? ' (K)' : '')
      : step.kind === 'allReset' ? t('workspace.allReset')
      : t(`workspace.${step.metadata.section === 'light' ? 'basic' : 'color'}`)
        + ' ' + t(step.kind === 'sectionToggle' ? step.metadata.enabled ? 'workspace.basicOn' : 'workspace.basicOff' : 'workspace.reset');
    return { id: step.stepId, position: offset + index + 1, description, createdAt: step.createdAt };
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
