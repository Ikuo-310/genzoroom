import { defaultRecipe, recipesEqual, type EditSession } from './editing';

export type AssetEditStatuses = Record<string, boolean | undefined>;

export function hasEdits(session: Pick<EditSession, 'recipe' | 'history' | 'pending'>): boolean {
  // Redo entries and bypassed settings remain edit data; rendered pixels do not define this status.
  return session.history.length > 0 || !recipesEqual(session.recipe, defaultRecipe())
    || (session.pending !== null && !recipesEqual(session.pending.before, session.recipe));
}
