import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { TEMPERATURE, TINT, formatHighlightsTemperature, formatHighlightsTint, formatMidtonesTemperature, formatMidtonesTint, formatShadowsTemperature, formatShadowsTint, type EditAction, type EditRecipe } from './editing';
import { TEMPERATURE_TRACK_GRADIENT, TINT_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';

export function ColorGradingAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return <>
    <div className="grading-range-header"><h4 className="adjustment-subsection-title">{t('workspace.shadowsGrading')}</h4>
      <button type="button" className={`adjustment-category-icon grading-range-toggle${recipe.gradingShadowsEnabled ? '' : ' is-off'}`}
        aria-pressed={recipe.gradingShadowsEnabled}
        aria-label={t(recipe.gradingShadowsEnabled ? 'workspace.disableShadowsGrading' : 'workspace.enableShadowsGrading')}
        onClick={() => dispatch({ type: 'toggleGradingShadows' })}>⏻</button></div>
    <AdjustmentSlider key={`${assetId}-shadows-temperature`} adjustmentId="shadowsTemperature" label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.shadowsTemperature} valueText={formatShadowsTemperature(recipe.adjustments.shadowsTemperature)}
      valueLabel={t('workspace.shadowsTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingShadowsEnabled} resetLabel={t('workspace.shadowsTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTemperature' })}
      onChange={(value) => dispatch({ type: 'shadowsTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTemperature' })}
      onReset={() => dispatch({ type: 'shadowsTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-shadows-tint`} adjustmentId="shadowsTint" label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.shadowsTint} valueText={formatShadowsTint(recipe.adjustments.shadowsTint)}
      valueLabel={t('workspace.shadowsTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingShadowsEnabled} resetLabel={t('workspace.shadowsTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTint' })}
      onChange={(value) => dispatch({ type: 'shadowsTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTint' })}
      onReset={() => dispatch({ type: 'shadowsTintReset' })} />
    <div className="grading-range-header"><h4 className="adjustment-subsection-title">{t('workspace.midtonesGrading')}</h4>
      <button type="button" className={`adjustment-category-icon grading-range-toggle${recipe.gradingMidtonesEnabled ? '' : ' is-off'}`}
        aria-pressed={recipe.gradingMidtonesEnabled}
        aria-label={t(recipe.gradingMidtonesEnabled ? 'workspace.disableMidtonesGrading' : 'workspace.enableMidtonesGrading')}
        onClick={() => dispatch({ type: 'toggleGradingMidtones' })}>⏻</button></div>
    <AdjustmentSlider key={`${assetId}-midtones-temperature`} adjustmentId="midtonesTemperature" label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.midtonesTemperature} valueText={formatMidtonesTemperature(recipe.adjustments.midtonesTemperature)}
      valueLabel={t('workspace.midtonesTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingMidtonesEnabled} resetLabel={t('workspace.midtonesTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTemperature' })}
      onChange={(value) => dispatch({ type: 'midtonesTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTemperature' })}
      onReset={() => dispatch({ type: 'midtonesTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-midtones-tint`} adjustmentId="midtonesTint" label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.midtonesTint} valueText={formatMidtonesTint(recipe.adjustments.midtonesTint)}
      valueLabel={t('workspace.midtonesTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingMidtonesEnabled} resetLabel={t('workspace.midtonesTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTint' })}
      onChange={(value) => dispatch({ type: 'midtonesTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTint' })}
      onReset={() => dispatch({ type: 'midtonesTintReset' })} />
    <div className="grading-range-header"><h4 className="adjustment-subsection-title">{t('workspace.highlightsGrading')}</h4>
      <button type="button" className={`adjustment-category-icon grading-range-toggle${recipe.gradingHighlightsEnabled ? '' : ' is-off'}`}
        aria-pressed={recipe.gradingHighlightsEnabled}
        aria-label={t(recipe.gradingHighlightsEnabled ? 'workspace.disableHighlightsGrading' : 'workspace.enableHighlightsGrading')}
        onClick={() => dispatch({ type: 'toggleGradingHighlights' })}>⏻</button></div>
    <AdjustmentSlider key={`${assetId}-highlights-temperature`} adjustmentId="highlightsTemperature" label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.highlightsTemperature} valueText={formatHighlightsTemperature(recipe.adjustments.highlightsTemperature)}
      valueLabel={t('workspace.highlightsTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled || !recipe.gradingHighlightsEnabled} resetLabel={t('workspace.highlightsTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'highlightsTemperature' })}
      onChange={(value) => dispatch({ type: 'highlightsTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'highlightsTemperature' })}
      onReset={() => dispatch({ type: 'highlightsTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-highlights-tint`} adjustmentId="highlightsTint" label={t('workspace.tint')} {...TINT}
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
