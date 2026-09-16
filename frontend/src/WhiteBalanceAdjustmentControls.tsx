import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { TEMPERATURE, TINT, formatTemperature, formatTint, type EditAction, type EditRecipe } from './editing';

// Negative values warm the preview; positive values cool it.
export const TEMPERATURE_TRACK_GRADIENT = 'linear-gradient(to right, #d86943 0%, #b6b6b6 50%, #4e8ed9 100%)';
export const TINT_TRACK_GRADIENT = 'linear-gradient(to right, #4f9b62 0%, #b6b6b6 50%, #b05aa0 100%)';

export function WhiteBalanceAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return <>
    <AdjustmentSlider key={`${assetId}-temperature`} label={t('workspace.temperature')} {...TEMPERATURE}
      value={recipe.adjustments.temperature} valueText={formatTemperature(recipe.adjustments.temperature)}
      valueLabel={t('workspace.temperatureValue')} precision={0} defaultValue={0}
      disabled={!recipe.whiteBalanceEnabled} resetLabel={t('workspace.temperatureReset')}
      trackGradient={TEMPERATURE_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'temperature' })}
      onChange={(value) => dispatch({ type: 'temperature', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'temperature' })}
      onReset={() => dispatch({ type: 'temperatureReset' })} />
    <AdjustmentSlider key={`${assetId}-tint`} label={t('workspace.tint')} {...TINT}
      value={recipe.adjustments.tint} valueText={formatTint(recipe.adjustments.tint)}
      valueLabel={t('workspace.tintValue')} precision={0} defaultValue={0}
      disabled={!recipe.whiteBalanceEnabled} resetLabel={t('workspace.tintReset')}
      trackGradient={TINT_TRACK_GRADIENT}
      onBegin={() => dispatch({ type: 'begin', kind: 'tint' })}
      onChange={(value) => dispatch({ type: 'tint', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'tint' })}
      onReset={() => dispatch({ type: 'tintReset' })} />
  </>;
}
