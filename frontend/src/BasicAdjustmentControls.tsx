import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { BASIC_ADJUSTMENT_KEYS, defaultRecipe, type EditAction, type EditRecipe } from './editing';
import { BASIC_CONTROLS } from './basicControls';

export function BasicAdjustmentControls({ assetId, recipe, dispatch }: {
  assetId: string; recipe: EditRecipe; dispatch: (action: EditAction) => void;
}) {
  const { t } = useTranslation();
  return BASIC_ADJUSTMENT_KEYS.map((key) => {
    const control = BASIC_CONTROLS[key];
    const value = recipe.adjustments[key];
    return <AdjustmentSlider key={`${assetId}-${key}`} adjustmentId={key} label={t(control.label)} value={value}
      min={control.min} max={control.max} step={control.step}
      valueText={`${control.format(value)}${control.unit ? ` ${control.unit}` : ''}`}
      valueLabel={t(control.valueLabel)} unit={control.unit} precision={control.precision}
      defaultValue={defaultRecipe().adjustments[key]} disabled={!recipe.basicEnabled}
      resetLabel={t(control.resetLabel)}
      onBegin={() => dispatch({ type: 'begin', kind: key })}
      onChange={(value) => dispatch({ type: key, value })}
      onCommit={() => dispatch({ type: 'commit', kind: key })}
      onReset={() => dispatch({ type: control.reset })} />;
  });
}
