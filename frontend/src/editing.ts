import type { RecentAsset } from './assets';

export type EditRecipe = { version: 4; adjustments: { exposure: number; contrast: number; highlights: number; whites: number; shadows: number } };
export type EditKind = 'exposure' | 'contrast' | 'highlights' | 'whites' | 'shadows' | 'exposureReset' | 'contrastReset' | 'highlightsReset' | 'whitesReset' | 'shadowsReset' | 'allReset';
export type EditEntry = { kind: EditKind; before: EditRecipe; after: EditRecipe };
export type EditSession = {
  recipe: EditRecipe;
  history: EditEntry[];
  cursor: number;
  pending: { kind: EditKind; before: EditRecipe } | null;
};
export const EXPOSURE = { min: -5, max: 5, step: 0.01 };
export const CONTRAST = { min: -100, max: 100, step: 1 };
export const HIGHLIGHTS = { min: -100, max: 100, step: 1 };
export const WHITES = { min: -100, max: 100, step: 1 };
export const SHADOWS = { min: -100, max: 100, step: 1 };
export const defaultRecipe = (): EditRecipe => ({ version: 4, adjustments: { exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0 } });
export const newSession = (): EditSession => ({ recipe: defaultRecipe(), history: [], cursor: 0, pending: null });
export const supportsEditing = (asset: RecentAsset) => !asset.is_raw && asset.format === 'JPEG';
export const formatExposure = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
export const formatContrast = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatHighlights = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatWhites = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatShadows = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const normalizeExposure = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(EXPOSURE.min, Math.min(EXPOSURE.max, value)) * 100) / 100 : 0;
export const normalizeContrast = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(CONTRAST.min, Math.min(CONTRAST.max, value))) : 0;
export const normalizeHighlights = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(HIGHLIGHTS.min, Math.min(HIGHLIGHTS.max, value))) : 0;
export const normalizeWhites = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(WHITES.min, Math.min(WHITES.max, value))) : 0;
export const normalizeShadows = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(SHADOWS.min, Math.min(SHADOWS.max, value))) : 0;

export type EditAction = { type: 'begin'; kind: EditKind } | { type: 'exposure' | 'contrast' | 'highlights' | 'whites' | 'shadows'; value: number }
  | { type: 'commit'; kind?: EditKind }
  | { type: 'undo' | 'redo' | 'exposureReset' | 'contrastReset' | 'highlightsReset' | 'whitesReset' | 'shadowsReset' | 'allReset' };

function recipesEqual(left: EditRecipe, right: EditRecipe) {
  return left.adjustments.exposure === right.adjustments.exposure
    && left.adjustments.contrast === right.adjustments.contrast
    && left.adjustments.highlights === right.adjustments.highlights
    && left.adjustments.whites === right.adjustments.whites
    && left.adjustments.shadows === right.adjustments.shadows;
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
    case 'highlights': return {
      ...editSession(state, { type: 'begin', kind: 'highlights' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, highlights: normalizeHighlights(action.value) } },
    };
    case 'whites': return {
      ...editSession(state, { type: 'begin', kind: 'whites' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, whites: normalizeWhites(action.value) } },
    };
    case 'shadows': return {
      ...editSession(state, { type: 'begin', kind: 'shadows' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, shadows: normalizeShadows(action.value) } },
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
    case 'highlightsReset':
    case 'whitesReset':
    case 'shadowsReset':
    case 'allReset': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: action.type, before: current.recipe },
        recipe: action.type === 'allReset' ? defaultRecipe() : {
          ...current.recipe,
          adjustments: { ...current.recipe.adjustments,
            [action.type === 'exposureReset' ? 'exposure'
              : action.type === 'contrastReset' ? 'contrast'
                : action.type === 'highlightsReset' ? 'highlights'
                  : action.type === 'whitesReset' ? 'whites' : 'shadows']: 0 },
        } });
    }
  }
}

export function editAsset(sessions: Record<string, EditSession>, id: string, action: EditAction) {
  return { ...sessions, [id]: editSession(sessions[id] ?? newSession(), action) };
}
