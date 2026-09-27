import { useTranslation } from 'react-i18next';
import { AdjustmentSlider, type OpenAdjustmentSliderMenu } from './AdjustmentSlider';
import { BASIC_ADJUSTMENT_KEYS, defaultRecipe, type EditAction, type EditRecipe } from './editing';
import { BASIC_CONTROLS } from './basicControls';

export function BasicAdjustmentControls({ assetId, recipe, dispatch, onOpenContextMenu }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void; onOpenContextMenu?: OpenAdjustmentSliderMenu;
}) {
  const { t } = useTranslation();
  return BASIC_ADJUSTMENT_KEYS.map((key) => {
    const control = BASIC_CONTROLS[key];
    const value = recipe.adjustments[key];
    return <AdjustmentSlider key={`${assetId}-${key}`} adjustmentId={key}
      enabled={recipe.adjustmentEnabled[key]} onToggle={() => dispatch({ type: 'toggleAdjustment', id: key })} onOpenContextMenu={onOpenContextMenu} label={t(control.label)} value={value}
      min={control.min} max={control.max} step={control.step}
      valueText={`${control.format(value)}${control.unit ? ` ${control.unit}` : ''}`}
      valueLabel={t(control.valueLabel)} precision={control.precision}
      defaultValue={defaultRecipe().adjustments[key]} disabled={!recipe.basicEnabled}
      resetLabel={t(control.resetLabel)}
      onBegin={() => dispatch({ type: 'begin', kind: key })}
      onChange={(value) => dispatch({ type: key, value })}
      onCommit={() => dispatch({ type: 'commit', kind: key })}
      onReset={() => dispatch({ type: control.reset })} />;
  });
}
