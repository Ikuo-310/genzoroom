import { useTranslation } from 'react-i18next';
import { AdjustmentSlider, type OpenAdjustmentSliderMenu } from './AdjustmentSlider';
import { SATURATION, VIBRANCE, formatSaturation, formatVibrance, type EditAction, type EditRecipe } from './editing';

export function ColorAdjustmentControls({ assetId, recipe, dispatch, onOpenContextMenu }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void; onOpenContextMenu?: OpenAdjustmentSliderMenu;
}) {
  const { t } = useTranslation();
  return <>
    <AdjustmentSlider key={`${assetId}-vibrance`} adjustmentId="vibrance"
      enabled={recipe.adjustmentEnabled.vibrance} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'vibrance' })} onOpenContextMenu={onOpenContextMenu} label={t('workspace.vibrance')} {...VIBRANCE}
      value={recipe.adjustments.vibrance} valueText={formatVibrance(recipe.adjustments.vibrance)}
      valueLabel={t('workspace.vibranceValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorEnabled} resetLabel={t('workspace.vibranceReset')}
      onBegin={() => dispatch({ type: 'begin', kind: 'vibrance' })}
      onChange={(value) => dispatch({ type: 'vibrance', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'vibrance' })}
      onReset={() => dispatch({ type: 'vibranceReset' })} />
    <AdjustmentSlider key={`${assetId}-saturation`} adjustmentId="saturation"
      enabled={recipe.adjustmentEnabled.saturation} onToggle={() => dispatch({ type: 'toggleAdjustment', id: 'saturation' })} onOpenContextMenu={onOpenContextMenu} label={t('workspace.saturation')} {...SATURATION}
      value={recipe.adjustments.saturation} valueText={formatSaturation(recipe.adjustments.saturation)}
      valueLabel={t('workspace.saturationValue')} precision={0} defaultValue={0}
      disabled={!recipe.colorEnabled} resetLabel={t('workspace.saturationReset')}
      onBegin={() => dispatch({ type: 'begin', kind: 'saturation' })}
      onChange={(value) => dispatch({ type: 'saturation', value })}
      onCommit={() => dispatch({ type: 'commit', kind: 'saturation' })}
      onReset={() => dispatch({ type: 'saturationReset' })} />
  </>;
}
