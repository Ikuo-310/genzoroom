import type { RecentAsset } from './assets';

export type EditRecipe = { version: 1; adjustments: { exposure: number; contrast: number } };
export type EditKind = 'exposure' | 'contrast' | 'exposureReset' | 'contrastReset' | 'allReset';
export type EditEntry = { kind: EditKind; before: EditRecipe; after: EditRecipe };
export type EditSession = {
  recipe: EditRecipe;
  history: EditEntry[];
  cursor: number;
  pending: { kind: EditKind; before: EditRecipe } | null;
};
export const EXPOSURE = { min: -5, max: 5, step: 0.01 };
export const CONTRAST = { min: -100, max: 100, step: 1 };
export const defaultRecipe = (): EditRecipe => ({ version: 1, adjustments: { exposure: 0, contrast: 0 } });
export const newSession = (): EditSession => ({ recipe: defaultRecipe(), history: [], cursor: 0, pending: null });
export const supportsEditing = (asset: RecentAsset) => !asset.is_raw && asset.format === 'JPEG';
export const formatExposure = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
export const formatContrast = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const normalizeExposure = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(EXPOSURE.min, Math.min(EXPOSURE.max, value)) * 100) / 100 : 0;
export const normalizeContrast = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(CONTRAST.min, Math.min(CONTRAST.max, value))) : 0;

export type EditAction = { type: 'begin'; kind: EditKind } | { type: 'exposure' | 'contrast'; value: number }
  | { type: 'commit'; kind?: EditKind }
  | { type: 'undo' | 'redo' | 'exposureReset' | 'contrastReset' | 'allReset' };

function recipesEqual(left: EditRecipe, right: EditRecipe) {
  return left.adjustments.exposure === right.adjustments.exposure
    && left.adjustments.contrast === right.adjustments.contrast;
}

function commit(state: EditSession): EditSession {
  if (!state.pending) return state;
  if (recipesEqual(state.pending.before, state.recipe)) return { ...state, pending: null };
  const history = [...state.history.slice(0, state.cursor), { ...state.pending, after: state.recipe }];
  return { ...state, history, cursor: history.length, pending: null };
}

export function editSession(state: EditSession, action: EditAction): EditSession {
  switch (action.type) {
    case 'begin': {
      if (state.pending?.kind === action.kind) return state;
      const current = commit(state);
      return { ...current, pending: { kind: action.kind, before: current.recipe } };
    }
    case 'exposure': return {
      ...editSession(state, { type: 'begin', kind: 'exposure' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, exposure: normalizeExposure(action.value) } },
    };
    case 'contrast': return {
      ...editSession(state, { type: 'begin', kind: 'contrast' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, contrast: normalizeContrast(action.value) } },
    };
    case 'commit': return action.kind && state.pending?.kind !== action.kind ? state : commit(state);
    case 'undo': {
      const current = commit(state);
      return current.cursor === 0 ? current : { ...current, cursor: current.cursor - 1, recipe: current.history[current.cursor - 1].before };
    }
    case 'redo': {
      const current = commit(state);
      return current.cursor === current.history.length ? current : { ...current, cursor: current.cursor + 1, recipe: current.history[current.cursor].after };
    }
    case 'exposureReset':
    case 'contrastReset':
    case 'allReset': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: action.type, before: current.recipe },
        recipe: action.type === 'allReset' ? defaultRecipe() : {
          ...current.recipe,
          adjustments: { ...current.recipe.adjustments, [action.type === 'exposureReset' ? 'exposure' : 'contrast']: 0 },
        } });
    }
  }
}

export function editAsset(sessions: Record<string, EditSession>, id: string, action: EditAction) {
  return { ...sessions, [id]: editSession(sessions[id] ?? newSession(), action) };
}
