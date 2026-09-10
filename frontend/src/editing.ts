import type { RecentAsset } from './assets';

export type EditRecipe = { version: 1; adjustments: { exposure: number } };
export type EditKind = 'exposure' | 'exposureReset' | 'allReset';
export type EditEntry = { kind: EditKind; before: EditRecipe; after: EditRecipe };
export type EditSession = {
  recipe: EditRecipe;
  history: EditEntry[];
  cursor: number;
  pending: { kind: EditKind; before: EditRecipe } | null;
};
export const EXPOSURE = { min: -5, max: 5, step: 0.01 };
export const defaultRecipe = (): EditRecipe => ({ version: 1, adjustments: { exposure: 0 } });
export const newSession = (): EditSession => ({ recipe: defaultRecipe(), history: [], cursor: 0, pending: null });
export const supportsEditing = (asset: RecentAsset) => !asset.is_raw && asset.format === 'JPEG';
export const formatExposure = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
export const normalizeExposure = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(EXPOSURE.min, Math.min(EXPOSURE.max, value)) * 100) / 100 : 0;

export type EditAction = { type: 'begin'; kind: EditKind } | { type: 'exposure'; value: number }
  | { type: 'commit' | 'undo' | 'redo' | 'exposureReset' | 'allReset' };

function commit(state: EditSession): EditSession {
  if (!state.pending) return state;
  if (state.pending.before.adjustments.exposure === state.recipe.adjustments.exposure) return { ...state, pending: null };
  const history = [...state.history.slice(0, state.cursor), { ...state.pending, after: state.recipe }];
  return { ...state, history, cursor: history.length, pending: null };
}

export function editSession(state: EditSession, action: EditAction): EditSession {
  switch (action.type) {
    case 'begin': return state.pending ? state : { ...state, pending: { kind: action.kind, before: state.recipe } };
    case 'exposure': return {
      ...editSession(state, { type: 'begin', kind: 'exposure' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, exposure: normalizeExposure(action.value) } },
    };
    case 'commit': return commit(state);
    case 'undo': {
      const current = commit(state);
      return current.cursor === 0 ? current : { ...current, cursor: current.cursor - 1, recipe: current.history[current.cursor - 1].before };
    }
    case 'redo': {
      const current = commit(state);
      return current.cursor === current.history.length ? current : { ...current, cursor: current.cursor + 1, recipe: current.history[current.cursor].after };
    }
    case 'exposureReset':
    case 'allReset': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: action.type, before: current.recipe },
        recipe: action.type === 'allReset' ? defaultRecipe() : { ...current.recipe, adjustments: { ...current.recipe.adjustments, exposure: 0 } } });
    }
  }
}

export function editAsset(sessions: Record<string, EditSession>, id: string, action: EditAction) {
  return { ...sessions, [id]: editSession(sessions[id] ?? newSession(), action) };
}
