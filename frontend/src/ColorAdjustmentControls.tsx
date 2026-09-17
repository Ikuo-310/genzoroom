import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { SATURATION, formatSaturation, type EditAction, type EditRecipe } from './editing';

export function ColorAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return <AdjustmentSlider key={`${assetId}-saturation`} label={t('workspace.saturation')} {...SATURATION}
    value={recipe.adjustments.saturation} valueText={formatSaturation(recipe.adjustments.saturation)}
    valueLabel={t('workspace.saturationValue')} precision={0} defaultValue={0}
    disabled={!recipe.colorEnabled} resetLabel={t('workspace.saturationReset')}
    onBegin={() => dispatch({ type: 'begin', kind: 'saturation' })}
    onChange={(value) => dispatch({ type: 'saturation', value })}
    onCommit={() => dispatch({ type: 'commit', kind: 'saturation' })}
    onReset={() => dispatch({ type: 'saturationReset' })} />;
}
