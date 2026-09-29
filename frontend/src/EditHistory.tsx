import { useTranslation } from 'react-i18next';
import { basicHistoryControl } from './basicControls';
import {
  ADJUSTMENT_TOGGLE_IDS,
  GRADING_RANGE_CONTROLS,
  formatHighlightsTemperature,
  formatHighlightsTint,
  formatMidtonesTemperature,
  formatMidtonesTint,
  formatSaturation,
  formatShadowsTemperature,
  formatShadowsTint,
  formatTemperature,
  formatTint,
  formatVibrance,
  type EditEntry,
} from './editing';

export function EditHistory({ history, cursor, disabled = false, onJump = () => undefined, onMenu }: {
  history: readonly EditEntry[]; cursor: number; disabled?: boolean; onJump?: (cursor: number) => void;
  onMenu?: (cursor: number, trigger: HTMLElement, x?: number, y?: number) => void;
}) {
  const { t } = useTranslation();
  const newestFirst = history.map((entry, index) => ({ entry, index })).reverse();

  return <ol className="edit-history">
    {newestFirst.map(({ entry, index }) => {
      const control = basicHistoryControl(entry.kind);
      let description: string;
      switch (entry.kind) {
        case 'paste': description = t('workspace.pasteHistory', { filename: entry.metadata.sourceFilename }); break;
        case 'temperature':
        case 'temperatureReset':
          description = t(entry.kind === 'temperature' ? 'workspace.temperature' : 'workspace.temperatureReset')
            + ' ' + formatTemperature(entry.before.adjustments.temperature) + ' → ' + formatTemperature(entry.after.adjustments.temperature);
          break;
        case 'tint':
        case 'tintReset':
          description = t(entry.kind === 'tint' ? 'workspace.tint' : 'workspace.tintReset')
            + ' ' + formatTint(entry.before.adjustments.tint) + ' → ' + formatTint(entry.after.adjustments.tint);
          break;
        case 'whiteBalanceReset': description = t('workspace.whiteBalanceResetHistory'); break;
        case 'whiteBalanceToggle':
          description = t('workspace.whiteBalance') + ' ' + t(entry.after.whiteBalanceEnabled ? 'workspace.basicOn' : 'workspace.basicOff');
          break;
        case 'allReset': description = t('workspace.allReset'); break;
        case 'basicReset': description = t('workspace.basicResetHistory'); break;
        case 'basicToggle':
          description = `${t('workspace.basic')} ${t(entry.after.basicEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        case 'shadowsTemperature':
        case 'shadowsTemperatureReset':
          description = t(entry.kind === 'shadowsTemperature' ? 'workspace.shadowsTemperatureHistory' : 'workspace.shadowsTemperatureReset')
            + ' ' + formatShadowsTemperature(entry.before.adjustments.shadowsTemperature) + ' → ' + formatShadowsTemperature(entry.after.adjustments.shadowsTemperature);
          break;
        case 'shadowsTint':
        case 'shadowsTintReset':
          description = t(entry.kind === 'shadowsTint' ? 'workspace.shadowsTintHistory' : 'workspace.shadowsTintReset')
            + ' ' + formatShadowsTint(entry.before.adjustments.shadowsTint) + ' → ' + formatShadowsTint(entry.after.adjustments.shadowsTint);
          break;
        case 'midtonesTemperature':
        case 'midtonesTemperatureReset':
          description = t(entry.kind === 'midtonesTemperature' ? 'workspace.midtonesTemperatureHistory' : 'workspace.midtonesTemperatureReset')
            + ' ' + formatMidtonesTemperature(entry.before.adjustments.midtonesTemperature) + ' → ' + formatMidtonesTemperature(entry.after.adjustments.midtonesTemperature);
          break;
        case 'midtonesTint':
        case 'midtonesTintReset':
          description = t(entry.kind === 'midtonesTint' ? 'workspace.midtonesTintHistory' : 'workspace.midtonesTintReset')
            + ' ' + formatMidtonesTint(entry.before.adjustments.midtonesTint) + ' → ' + formatMidtonesTint(entry.after.adjustments.midtonesTint);
          break;
        case 'highlightsTemperature':
        case 'highlightsTemperatureReset':
          description = t(entry.kind === 'highlightsTemperature' ? 'workspace.highlightsTemperatureHistory' : 'workspace.highlightsTemperatureReset')
            + ' ' + formatHighlightsTemperature(entry.before.adjustments.highlightsTemperature) + ' → ' + formatHighlightsTemperature(entry.after.adjustments.highlightsTemperature);
          break;
        case 'highlightsTint':
        case 'highlightsTintReset':
          description = t(entry.kind === 'highlightsTint' ? 'workspace.highlightsTintHistory' : 'workspace.highlightsTintReset')
            + ' ' + formatHighlightsTint(entry.before.adjustments.highlightsTint) + ' → ' + formatHighlightsTint(entry.after.adjustments.highlightsTint);
          break;
        case 'gradingShadowsReset':
        case 'gradingMidtonesReset':
        case 'gradingHighlightsReset': {
          const range = GRADING_RANGE_CONTROLS.find(range => range.reset === entry.kind)!;
          description = t('workspace.resetGradingRange', { name: t(range.label) });
          break;
        }
        case 'colorGradingReset': description = t('workspace.colorGradingResetHistory'); break;
        case 'colorGradingToggle':
          description = `${t('workspace.colorGrading')} ${t(entry.after.colorGradingEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        case 'gradingShadowsToggle':
          description = `${t('workspace.shadowsGrading')} ${t(entry.after.gradingShadowsEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        case 'gradingMidtonesToggle':
          description = `${t('workspace.midtonesGrading')} ${t(entry.after.gradingMidtonesEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        case 'gradingHighlightsToggle':
          description = `${t('workspace.highlightsGrading')} ${t(entry.after.gradingHighlightsEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        case 'saturation':
        case 'saturationReset':
          description = t(entry.kind === 'saturation' ? 'workspace.saturation' : 'workspace.saturationReset')
            + ' ' + formatSaturation(entry.before.adjustments.saturation) + ' → ' + formatSaturation(entry.after.adjustments.saturation);
          break;
        case 'vibrance':
        case 'vibranceReset':
          description = t(entry.kind === 'vibrance' ? 'workspace.vibrance' : 'workspace.vibranceReset')
            + ' ' + formatVibrance(entry.before.adjustments.vibrance) + ' → ' + formatVibrance(entry.after.adjustments.vibrance);
          break;
        case 'colorReset': description = t('workspace.colorResetHistory'); break;
        case 'colorToggle':
          description = `${t('workspace.color')} ${t(entry.after.colorEnabled ? 'workspace.basicOn' : 'workspace.basicOff')}`;
          break;
        default: {
          const individual = Object.hasOwn(ADJUSTMENT_TOGGLE_IDS, entry.kind)
            ? ADJUSTMENT_TOGGLE_IDS[entry.kind as keyof typeof ADJUSTMENT_TOGGLE_IDS] : undefined;
          description = individual
            ? `${t(`workspace.${individual}${individual.endsWith('Temperature') || individual.endsWith('Tint') ? 'History' : ''}`)} ${t(entry.after.adjustmentEnabled[individual] ? 'workspace.basicOn' : 'workspace.basicOff')}`
            : control
            ? `${t(entry.kind === control.reset ? control.resetLabel : control.label)} ${control.format(entry.before.adjustments[control.key])} → ${control.format(entry.after.adjustments[control.key])}`
            : entry.kind;
          break;
        }
      }
      const className = [index >= cursor ? 'undone' : '', index + 1 === cursor ? 'current' : ''].filter(Boolean).join(' ') || undefined;
      return <li key={index} value={index + 1} className={className}
        title={entry.kind === 'paste' ? description : undefined}
      >
        <button type="button" disabled={disabled} aria-current={index + 1 === cursor ? 'step' : undefined}
          onContextMenu={(event) => { if (!disabled && onMenu) { event.preventDefault(); onMenu(index + 1, event.currentTarget, event.clientX, event.clientY); } }}
          onKeyDown={(event) => { if (!disabled && onMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault(); onMenu(index + 1, event.currentTarget);
          } }}
          onClick={() => onJump(index + 1)}>
          {entry.kind === 'paste' ? <span className="edit-history-paste">{description}</span> : description}
        </button>
      </li>;
    })}
    <li className={`initial-state${cursor === 0 ? ' current' : ''}`}>
      <button type="button" disabled={disabled} aria-current={cursor === 0 ? 'step' : undefined}
        onContextMenu={(event) => { if (!disabled && onMenu) { event.preventDefault(); onMenu(cursor, event.currentTarget, event.clientX, event.clientY); } }}
        onKeyDown={(event) => { if (!disabled && onMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault(); onMenu(cursor, event.currentTarget);
        } }}
        onClick={() => onJump(0)}>{t('workspace.initialState')}</button>
    </li>
  </ol>;
}
