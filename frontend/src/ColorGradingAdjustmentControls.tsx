import { useTranslation } from 'react-i18next';
import { AdjustmentSlider, focusAdjustmentCategory, navigateAdjustments, type OpenAdjustmentSliderMenu } from './AdjustmentSlider';
import { GRADING_RANGE_CONTROLS, type GradingRangeId, TEMPERATURE, TINT, formatHighlightsTemperature, formatHighlightsTint, formatMidtonesTemperature, formatMidtonesTint, formatShadowsTemperature, formatShadowsTint, type EditAction, type EditRecipe } from './editing';
import { TEMPERATURE_TRACK_GRADIENT, TINT_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';

import type { AdjustmentMenuPosition } from './AdjustmentContextMenu';
export type GradingRangeMenuTarget = AdjustmentMenuPosition & { rangeId: GradingRangeId };

export function ColorGradingAdjustmentControls({ assetId, recipe, dispatch, onOpenContextMenu, onOpenRangeMenu }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void; onOpenContextMenu?: OpenAdjustmentSliderMenu; onOpenRangeMenu?: (target: GradingRangeMenuTarget) => void;
}) {
  const { t } = useTranslation();
  function header(id: GradingRangeId) {
    const range = GRADING_RANGE_CONTROLS.find(range => range.id === id)!;
    const name = t(range.label);
    const enabled = recipe[range.enabled];
    const toggleLabel = t(enabled ? 'workspace.disableAdjustment' : 'workspace.enableAdjustment', { name });
    const resetLabel = t('workspace.resetGradingRange', { name });
    return <div className="grading-range-header" onContextMenu={event => {
      if (!onOpenRangeMenu) return;
      event.preventDefault();
      onOpenRangeMenu({ rangeId: id, trigger: event.currentTarget.querySelector<HTMLButtonElement>('.grading-range-title')!, x: event.clientX, y: event.clientY });
    }}>
      <h4 className="adjustment-subsection-title"><button type="button" className="grading-range-title" data-grading-range-id={id}
        onFocus={focusAdjustmentCategory} onKeyDown={event => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}>{name}</button></h4>
      <button type="button" className={`adjustment-category-icon grading-range-toggle${enabled ? '' : ' is-off'}`}
        aria-pressed={enabled} aria-label={toggleLabel} title={toggleLabel}
        onFocus={focusAdjustmentCategory} onKeyDown={event => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}
        onClick={() => dispatch({ type: range.toggle })}>⏻</button>
      <button type="button" className="adjustment-category-reset grading-range-reset" aria-label={resetLabel} title={resetLabel}
        disabled={range.ids.every(id => recipe.adjustments[id] === 0)}
        onFocus={focusAdjustmentCategory} onKeyDown={event => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}
        onClick={() => dispatch({ type: range.reset })}>{t('workspace.reset')}</button>
    </div>;
  }
  return <>
    {header('shadows')}
    <AdjustmentSlider key={`${assetId}-shadows-temperature`} adjustmentId="shadowsTemperature"
      enabled={recipe.adjustmentEnabled.shadowsTemperature} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'shadowsTemperature' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.shadowsTemperatureHistory')} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.shadowsTemperature} valueText={formatShadowsTemperature(recipe.adjustments.shadowsTemperature)}
      valueLabel={t('workspace.shadowsTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingShadowsEnabled} resetLabel={t('workspace.shadowsTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTemperature' })}
      onChange={(value) => dispatch({ type: 'shadowsTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTemperature' })}
      onReset={() => dispatch({ type: 'shadowsTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-shadows-tint`} adjustmentId="shadowsTint"
      enabled={recipe.adjustmentEnabled.shadowsTint} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'shadowsTint' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.shadowsTintHistory')} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.shadowsTint} valueText={formatShadowsTint(recipe.adjustments.shadowsTint)}
      valueLabel={t('workspace.shadowsTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingShadowsEnabled} resetLabel={t('workspace.shadowsTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTint' })}
      onChange={(value) => dispatch({ type: 'shadowsTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTint' })}
      onReset={() => dispatch({ type: 'shadowsTintReset' })} />
    {header('midtones')}
    <AdjustmentSlider key={`${assetId}-midtones-temperature`} adjustmentId="midtonesTemperature"
      enabled={recipe.adjustmentEnabled.midtonesTemperature} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'midtonesTemperature' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.midtonesTemperatureHistory')} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.midtonesTemperature} valueText={formatMidtonesTemperature(recipe.adjustments.midtonesTemperature)}
      valueLabel={t('workspace.midtonesTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingMidtonesEnabled} resetLabel={t('workspace.midtonesTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTemperature' })}
      onChange={(value) => dispatch({ type: 'midtonesTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTemperature' })}
      onReset={() => dispatch({ type: 'midtonesTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-midtones-tint`} adjustmentId="midtonesTint"
      enabled={recipe.adjustmentEnabled.midtonesTint} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'midtonesTint' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.midtonesTintHistory')} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.midtonesTint} valueText={formatMidtonesTint(recipe.adjustments.midtonesTint)}
      valueLabel={t('workspace.midtonesTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingMidtonesEnabled} resetLabel={t('workspace.midtonesTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTint' })}
      onChange={(value) => dispatch({ type: 'midtonesTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTint' })}
      onReset={() => dispatch({ type: 'midtonesTintReset' })} />
    {header('highlights')}
    <AdjustmentSlider key={`${assetId}-highlights-temperature`} adjustmentId="highlightsTemperature"
      enabled={recipe.adjustmentEnabled.highlightsTemperature} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'highlightsTemperature' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.highlightsTemperatureHistory')} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.highlightsTemperature} valueText={formatHighlightsTemperature(recipe.adjustments.highlightsTemperature)}
      valueLabel={t('workspace.highlightsTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingHighlightsEnabled} resetLabel={t('workspace.highlightsTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'highlightsTemperature' })}
      onChange={(value) => dispatch({ type: 'highlightsTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'highlightsTemperature' })}
      onReset={() => dispatch({ type: 'highlightsTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-highlights-tint`} adjustmentId="highlightsTint"
      enabled={recipe.adjustmentEnabled.highlightsTint} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'highlightsTint' })} onOpenContextMenu={onOpenContextMenu} operationName={t('workspace.highlightsTintHistory')} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.highlightsTint} valueText={formatHighlightsTint(recipe.adjustments.highlightsTint)}
      valueLabel={t('workspace.highlightsTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingHighlightsEnabled} resetLabel={t('workspace.highlightsTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'highlightsTint' })}
      onChange={(value) => dispatch({ type: 'highlightsTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'highlightsTint' })}
      onReset={() => dispatch({ type: 'highlightsTintReset' })} />
  </>;
}
