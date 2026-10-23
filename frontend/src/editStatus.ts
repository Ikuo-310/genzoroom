import { defaultRecipe, recipesEqual, type EditSession } from './editing';

export type AssetEditStatuses = Record<string, boolean | undefined>;

export function hasEdits(session: Pick<EditSession, 'recipe' | 'history' | 'pending'>): boolean {
  const defaults = defaultRecipe();
  // Recipe v18 keeps individual flags as stored data, but they no longer create an edit by themselves.
  const hasEffectiveHistory = session.history.some((entry) => !entry.kind.endsWith('Toggle')
    || !Object.hasOwn(defaults.adjustmentEnabled, entry.kind.slice(0, -'Toggle'.length)));
  const normalizedRecipe = { ...session.recipe, adjustmentEnabled: defaults.adjustmentEnabled };
  return hasEffectiveHistory || !recipesEqual(normalizedRecipe, defaults)
    || (session.pending !== null && !recipesEqual({ ...session.pending.before, adjustmentEnabled: defaults.adjustmentEnabled }, normalizedRecipe));
}
