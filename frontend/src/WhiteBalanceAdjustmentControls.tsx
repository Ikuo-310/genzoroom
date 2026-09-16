import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { TEMPERATURE, formatTemperature, type EditAction, type EditRecipe } from './editing';

// Negative values warm the preview; positive values cool it.
export const TEMPERATURE_TRACK_GRADIENT = 'linear-gradient(to right, #d86943 0%, #b6b6b6 50%, #4e8ed9 100%)';

export function WhiteBalanceAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return <AdjustmentSlider key={assetId} label={t('workspace.temperature')} {...TEMPERATURE}
    value={recipe.adjustments.temperature} valueText={formatTemperature(recipe.adjustments.temperature)}
    valueLabel={t('workspace.temperatureValue')} precision={0} defaultValue={0}
    disabled={!recipe.whiteBalanceEnabled} resetLabel={t('workspace.temperatureReset')}
    trackGradient={TEMPERATURE_TRACK_GRADIENT}
    onBegin={() => dispatch({ type: 'begin', kind: 'temperature' })}
    onChange={(value) => dispatch({ type: 'temperature', value })}
    onCommit={() => dispatch({ type: 'commit', kind: 'temperature' })}
    onReset={() => dispatch({ type: 'temperatureReset' })} />;
}
