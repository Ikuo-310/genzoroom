import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { TEMPERATURE, TINT, formatMidtonesTemperature, formatMidtonesTint, formatShadowsTemperature, formatShadowsTint, type EditAction, type EditRecipe } from './editing';
import { TEMPERATURE_TRACK_GRADIENT, TINT_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';

export function ColorGradingAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return <>
    <h4 className="adjustment-subsection-title">{t('workspace.shadowsGrading')}</h4>
    <AdjustmentSlider key={`${assetId}-shadows-temperature`} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.shadowsTemperature} valueText={formatShadowsTemperature(recipe.adjustments.shadowsTemperature)}
      valueLabel={t('workspace.shadowsTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled} resetLabel={t('workspace.shadowsTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTemperature' })}
      onChange={(value) => dispatch({ type: 'shadowsTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTemperature' })}
      onReset={() => dispatch({ type: 'shadowsTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-shadows-tint`} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.shadowsTint} valueText={formatShadowsTint(recipe.adjustments.shadowsTint)}
      valueLabel={t('workspace.shadowsTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled} resetLabel={t('workspace.shadowsTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadowsTint' })}
      onChange={(value) => dispatch({ type: 'shadowsTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'shadowsTint' })}
      onReset={() => dispatch({ type: 'shadowsTintReset' })} />
    <h4 className="adjustment-subsection-title">{t('workspace.midtonesGrading')}</h4>
    <AdjustmentSlider key={`${assetId}-midtones-temperature`} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.midtonesTemperature} valueText={formatMidtonesTemperature(recipe.adjustments.midtonesTemperature)}
      valueLabel={t('workspace.midtonesTemperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled} resetLabel={t('workspace.midtonesTemperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTemperature' })}
      onChange={(value) => dispatch({ type: 'midtonesTemperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTemperature' })}
      onReset={() => dispatch({ type: 'midtonesTemperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-midtones-tint`} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.midtonesTint} valueText={formatMidtonesTint(recipe.adjustments.midtonesTint)}
      valueLabel={t('workspace.midtonesTintValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorGradingEnabled} resetLabel={t('workspace.midtonesTintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'midtonesTint' })}
      onChange={(value) => dispatch({ type: 'midtonesTint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'midtonesTint' })}
      onReset={() => dispatch({ type: 'midtonesTintReset' })} />
  </>;
}
