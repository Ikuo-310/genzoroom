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

// Selection is a new payload, never a change to the shared clipboard.
export function selectEditClipboardItems(copy: EditClipboard, ids: readonly AdjustmentId[]): EditClipboard {
  const values: EditClipboard['values'] = {};
  for (const id of ids) if (Object.hasOwn(copy.values, id)) values[id] = copy.values[id];
  return { ...copy, values };
}
