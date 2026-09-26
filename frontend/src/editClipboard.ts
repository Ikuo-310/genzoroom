import { ADJUSTMENT_IDS, type AdjustmentId, type EditRecipe } from './editing';

export type EditClipboard = {
  values: Partial<EditRecipe['adjustments']>;
  sourceAssetId: string;
  sourceFilename: string;
};

// Module memory survives route changes within this tab, but never reloads.
let clipboard: EditClipboard | null = null;

export function copyEditSettings(
  recipe: EditRecipe, sourceAssetId: string, sourceFilename: string,
  adjustmentIds: readonly AdjustmentId[] = ADJUSTMENT_IDS,
): void {
  const values: EditClipboard['values'] = {};
  for (const id of adjustmentIds) values[id] = recipe.adjustments[id];
  clipboard = { values, sourceAssetId, sourceFilename };
}

// Callers cannot mutate the stored copy or a later Paste's History metadata.
export function readEditClipboard(): EditClipboard | null {
  return clipboard ? { ...clipboard, values: { ...clipboard.values } } : null;
}
