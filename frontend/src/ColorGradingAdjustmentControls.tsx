import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { TEMPERATURE, TINT, formatShadowsTemperature, formatShadowsTint, type EditAction, type EditRecipe } from './editing';
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
  </>;
}
