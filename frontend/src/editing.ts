import type { RecentAsset } from './assets';

export type EditRecipe = { version: 17; whiteBalanceEnabled: boolean; basicEnabled: boolean; colorGradingEnabled: boolean; gradingShadowsEnabled: boolean; gradingMidtonesEnabled: boolean; gradingHighlightsEnabled: boolean; colorEnabled: boolean; adjustments: { temperature: number; tint: number; exposure: number; contrast: number; highlights: number; whites: number; shadows: number; blacks: number; shadowsTemperature: number; shadowsTint: number; midtonesTemperature: number; midtonesTint: number; highlightsTemperature: number; highlightsTint: number; vibrance: number; saturation: number } };
export type EditKind = 'temperature' | 'temperatureReset' | 'tint' | 'tintReset' | 'whiteBalanceToggle' | 'whiteBalanceReset' | 'exposure' | 'contrast' | 'highlights' | 'whites' | 'shadows' | 'blacks' | 'exposureReset' | 'contrastReset' | 'highlightsReset' | 'whitesReset' | 'shadowsReset' | 'blacksReset' | 'basicToggle' | 'basicReset' | 'shadowsTemperature' | 'shadowsTemperatureReset' | 'shadowsTint' | 'shadowsTintReset' | 'midtonesTemperature' | 'midtonesTemperatureReset' | 'midtonesTint' | 'midtonesTintReset' | 'highlightsTemperature' | 'highlightsTemperatureReset' | 'highlightsTint' | 'highlightsTintReset' | 'colorGradingToggle' | 'colorGradingReset' | 'gradingShadowsToggle' | 'gradingMidtonesToggle' | 'gradingHighlightsToggle' | 'vibrance' | 'vibranceReset' | 'saturation' | 'saturationReset' | 'colorToggle' | 'colorReset' | 'allReset';
export type EditEntry = { kind: EditKind; before: EditRecipe; after: EditRecipe };
export type EditSession = {
  recipe: EditRecipe;
  history: EditEntry[];
  cursor: number;
  pending: { kind: EditKind; before: EditRecipe } | null;
};
export const TEMPERATURE = { min: -100, max: 100, step: 1 };
export const TINT = { min: -100, max: 100, step: 1 };
export const EXPOSURE = { min: -5, max: 5, step: 0.01 };
export const CONTRAST = { min: -100, max: 100, step: 1 };
export const HIGHLIGHTS = { min: -100, max: 100, step: 1 };
export const WHITES = { min: -100, max: 100, step: 1 };
export const SHADOWS = { min: -100, max: 100, step: 1 };
export const BLACKS = { min: -100, max: 100, step: 1 };
export const VIBRANCE = { min: -100, max: 100, step: 1 };
export const SATURATION = { min: -100, max: 100, step: 1 };
export const defaultRecipe = (): EditRecipe => ({ version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } });

// Basic membership is deliberately independent of all recipe adjustments.
export const BASIC_ADJUSTMENT_KEYS = ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] as const;
export type BasicAdjustmentKey = typeof BASIC_ADJUSTMENT_KEYS[number];
export function resetBasicAdjustments<T extends EditRecipe['adjustments']>(adjustments: T): T {
  const result = { ...adjustments };
  const defaults = defaultRecipe().adjustments;
  for (const key of BASIC_ADJUSTMENT_KEYS) result[key] = defaults[key];
  return result;
}
export function isBasicDefault(adjustments: EditRecipe['adjustments']): boolean {
  const defaults = defaultRecipe().adjustments;
  return BASIC_ADJUSTMENT_KEYS.every((key) => adjustments[key] === defaults[key]);
}
export const WHITE_BALANCE_ADJUSTMENT_KEYS = ['temperature', 'tint'] as const;
export function resetWhiteBalanceAdjustments<T extends EditRecipe['adjustments']>(adjustments: T): T {
  const result = { ...adjustments };
  const defaults = defaultRecipe().adjustments;
  for (const key of WHITE_BALANCE_ADJUSTMENT_KEYS) result[key] = defaults[key];
  return result;
}
export function isWhiteBalanceDefault(adjustments: EditRecipe['adjustments']): boolean {
  const defaults = defaultRecipe().adjustments;
  return WHITE_BALANCE_ADJUSTMENT_KEYS.every((key) => adjustments[key] === defaults[key]);
}
export const COLOR_GRADING_ADJUSTMENT_KEYS = ['shadowsTemperature', 'shadowsTint', 'midtonesTemperature', 'midtonesTint', 'highlightsTemperature', 'highlightsTint'] as const;
export function resetColorGradingAdjustments<T extends EditRecipe['adjustments']>(adjustments: T): T {
  const result = { ...adjustments };
  const defaults = defaultRecipe().adjustments;
  for (const key of COLOR_GRADING_ADJUSTMENT_KEYS) result[key] = defaults[key];
  return result;
}
export function isColorGradingDefault(adjustments: EditRecipe['adjustments']): boolean {
  const defaults = defaultRecipe().adjustments;
  return COLOR_GRADING_ADJUSTMENT_KEYS.every((key) => adjustments[key] === defaults[key]);
}
export const COLOR_ADJUSTMENT_KEYS = ['vibrance', 'saturation'] as const;
export function resetColorAdjustments<T extends EditRecipe['adjustments']>(adjustments: T): T {
  const result = { ...adjustments };
  const defaults = defaultRecipe().adjustments;
  for (const key of COLOR_ADJUSTMENT_KEYS) result[key] = defaults[key];
  return result;
}
export function isColorDefault(adjustments: EditRecipe['adjustments']): boolean {
  const defaults = defaultRecipe().adjustments;
  return COLOR_ADJUSTMENT_KEYS.every((key) => adjustments[key] === defaults[key]);
}
export function effectiveAdjustments(recipe: EditRecipe): EditRecipe['adjustments'] {
  const basic = recipe.basicEnabled ? recipe.adjustments : resetBasicAdjustments(recipe.adjustments);
  const whiteBalance = recipe.whiteBalanceEnabled ? basic : resetWhiteBalanceAdjustments(basic);
  let colorGrading = recipe.colorGradingEnabled ? whiteBalance : resetColorGradingAdjustments(whiteBalance);
  if (recipe.colorGradingEnabled) {
    if (!recipe.gradingShadowsEnabled) colorGrading = { ...colorGrading, shadowsTemperature: 0, shadowsTint: 0 };
    if (!recipe.gradingMidtonesEnabled) colorGrading = { ...colorGrading, midtonesTemperature: 0, midtonesTint: 0 };
    if (!recipe.gradingHighlightsEnabled) colorGrading = { ...colorGrading, highlightsTemperature: 0, highlightsTint: 0 };
  }
  return recipe.colorEnabled ? colorGrading : resetColorAdjustments(colorGrading);
}

export const newSession = (): EditSession => ({ recipe: defaultRecipe(), history: [], cursor: 0, pending: null });
export const supportsEditing = (asset: RecentAsset) => !asset.is_raw && asset.format === 'JPEG';
export const formatTemperature = (value: number) => (value > 0 ? '+' : '') + value.toFixed(0);
export const formatTint = (value: number) => (value > 0 ? '+' : '') + value.toFixed(0);
export const formatExposure = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
export const formatContrast = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatHighlights = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatWhites = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatShadows = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatBlacks = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatVibrance = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatSaturation = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
export const formatShadowsTemperature = formatTemperature;
export const formatShadowsTint = formatTint;
export const formatMidtonesTemperature = formatTemperature;
export const formatMidtonesTint = formatTint;
export const formatHighlightsTemperature = formatTemperature;
export const formatHighlightsTint = formatTint;
export const normalizeTemperature = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(TEMPERATURE.min, Math.min(TEMPERATURE.max, value))) : 0;
export const normalizeTint = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(TINT.min, Math.min(TINT.max, value))) : 0;
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
export const normalizeBlacks = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(BLACKS.min, Math.min(BLACKS.max, value))) : 0;
export const normalizeVibrance = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(VIBRANCE.min, Math.min(VIBRANCE.max, value))) : 0;
export const normalizeSaturation = (value: number) => Number.isFinite(value)
  ? Math.round(Math.max(SATURATION.min, Math.min(SATURATION.max, value))) : 0;
export const normalizeShadowsTemperature = normalizeTemperature;
export const normalizeShadowsTint = normalizeTint;
export const normalizeMidtonesTemperature = normalizeTemperature;
export const normalizeMidtonesTint = normalizeTint;
export const normalizeHighlightsTemperature = normalizeTemperature;
export const normalizeHighlightsTint = normalizeTint;

export type EditAction = { type: 'begin'; kind: EditKind } | { type: 'temperature' | 'tint' | 'exposure' | 'contrast' | 'highlights' | 'whites' | 'shadows' | 'blacks' | 'shadowsTemperature' | 'shadowsTint' | 'midtonesTemperature' | 'midtonesTint' | 'highlightsTemperature' | 'highlightsTint' | 'vibrance' | 'saturation'; value: number }
  | { type: 'commit'; kind?: EditKind }
  | { type: 'temperatureReset' | 'tintReset' | 'whiteBalanceReset' | 'toggleWhiteBalance' | 'undo' | 'redo' | 'exposureReset' | 'contrastReset' | 'highlightsReset' | 'whitesReset' | 'shadowsReset' | 'blacksReset' | 'toggleBasic' | 'basicReset' | 'shadowsTemperatureReset' | 'shadowsTintReset' | 'midtonesTemperatureReset' | 'midtonesTintReset' | 'highlightsTemperatureReset' | 'highlightsTintReset' | 'toggleColorGrading' | 'colorGradingReset' | 'toggleGradingShadows' | 'toggleGradingMidtones' | 'toggleGradingHighlights' | 'vibranceReset' | 'saturationReset' | 'toggleColor' | 'colorReset' | 'allReset' };

function recipesEqual(left: EditRecipe, right: EditRecipe) {
  return left.whiteBalanceEnabled === right.whiteBalanceEnabled
    && left.adjustments.temperature === right.adjustments.temperature
    && left.adjustments.tint === right.adjustments.tint
    && left.basicEnabled === right.basicEnabled
    && left.adjustments.exposure === right.adjustments.exposure
    && left.adjustments.contrast === right.adjustments.contrast
    && left.adjustments.highlights === right.adjustments.highlights
    && left.adjustments.whites === right.adjustments.whites
    && left.adjustments.shadows === right.adjustments.shadows
    && left.adjustments.blacks === right.adjustments.blacks
    && left.colorGradingEnabled === right.colorGradingEnabled
    && left.gradingShadowsEnabled === right.gradingShadowsEnabled
    && left.gradingMidtonesEnabled === right.gradingMidtonesEnabled
    && left.gradingHighlightsEnabled === right.gradingHighlightsEnabled
    && left.adjustments.shadowsTemperature === right.adjustments.shadowsTemperature
    && left.adjustments.shadowsTint === right.adjustments.shadowsTint
    && left.adjustments.midtonesTemperature === right.adjustments.midtonesTemperature
    && left.adjustments.midtonesTint === right.adjustments.midtonesTint
    && left.adjustments.highlightsTemperature === right.adjustments.highlightsTemperature
    && left.adjustments.highlightsTint === right.adjustments.highlightsTint
    && left.colorEnabled === right.colorEnabled
    && left.adjustments.vibrance === right.adjustments.vibrance
    && left.adjustments.saturation === right.adjustments.saturation;
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
    case 'temperature': return {
      ...editSession(state, { type: 'begin', kind: 'temperature' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, temperature: normalizeTemperature(action.value) } },
    };
    case 'tint': return {
      ...editSession(state, { type: 'begin', kind: 'tint' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, tint: normalizeTint(action.value) } },
    };
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
    case 'blacks': return {
      ...editSession(state, { type: 'begin', kind: 'blacks' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, blacks: normalizeBlacks(action.value) } },
    };
    case 'shadowsTemperature': return {
      ...editSession(state, { type: 'begin', kind: 'shadowsTemperature' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, shadowsTemperature: normalizeShadowsTemperature(action.value) } },
    };
    case 'shadowsTint': return {
      ...editSession(state, { type: 'begin', kind: 'shadowsTint' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, shadowsTint: normalizeShadowsTint(action.value) } },
    };
    case 'midtonesTemperature': return {
      ...editSession(state, { type: 'begin', kind: 'midtonesTemperature' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, midtonesTemperature: normalizeMidtonesTemperature(action.value) } },
    };
    case 'midtonesTint': return {
      ...editSession(state, { type: 'begin', kind: 'midtonesTint' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, midtonesTint: normalizeMidtonesTint(action.value) } },
    };
    case 'highlightsTemperature': return {
      ...editSession(state, { type: 'begin', kind: 'highlightsTemperature' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, highlightsTemperature: normalizeHighlightsTemperature(action.value) } },
    };
    case 'highlightsTint': return {
      ...editSession(state, { type: 'begin', kind: 'highlightsTint' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, highlightsTint: normalizeHighlightsTint(action.value) } },
    };
    case 'saturation': return {
      ...editSession(state, { type: 'begin', kind: 'saturation' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, saturation: normalizeSaturation(action.value) } },
    };
    case 'vibrance': return {
      ...editSession(state, { type: 'begin', kind: 'vibrance' }),
      recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, vibrance: normalizeVibrance(action.value) } },
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
    case 'temperatureReset':
    case 'tintReset':
    case 'whiteBalanceReset':
    case 'exposureReset':
    case 'contrastReset':
    case 'highlightsReset':
    case 'whitesReset':
    case 'shadowsReset':
    case 'blacksReset':
    case 'basicReset':
    case 'shadowsTemperatureReset':
    case 'shadowsTintReset':
    case 'midtonesTemperatureReset':
    case 'midtonesTintReset':
    case 'highlightsTemperatureReset':
    case 'highlightsTintReset':
    case 'colorGradingReset':
    case 'vibranceReset':
    case 'saturationReset':
    case 'colorReset':
    case 'allReset': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: action.type, before: current.recipe },
        recipe: action.type === 'allReset' ? defaultRecipe()
          : action.type === 'whiteBalanceReset' ? { ...current.recipe, adjustments: resetWhiteBalanceAdjustments(current.recipe.adjustments) }
          : action.type === 'basicReset' ? { ...current.recipe, adjustments: resetBasicAdjustments(current.recipe.adjustments) }
            : action.type === 'colorGradingReset' ? { ...current.recipe, adjustments: resetColorGradingAdjustments(current.recipe.adjustments) }
            : action.type === 'colorReset' ? { ...current.recipe, adjustments: resetColorAdjustments(current.recipe.adjustments) } : {
          ...current.recipe,
          adjustments: { ...current.recipe.adjustments,
            [action.type === 'temperatureReset' ? 'temperature' : action.type === 'tintReset' ? 'tint' : action.type === 'exposureReset' ? 'exposure'
              : action.type === 'contrastReset' ? 'contrast'
                : action.type === 'highlightsReset' ? 'highlights'
                  : action.type === 'whitesReset' ? 'whites'
                    : action.type === 'shadowsReset' ? 'shadows'
                      : action.type === 'blacksReset' ? 'blacks'
                        : action.type === 'shadowsTemperatureReset' ? 'shadowsTemperature'
                          : action.type === 'shadowsTintReset' ? 'shadowsTint'
                            : action.type === 'midtonesTemperatureReset' ? 'midtonesTemperature'
                              : action.type === 'midtonesTintReset' ? 'midtonesTint'
                                : action.type === 'highlightsTemperatureReset' ? 'highlightsTemperature'
                                  : action.type === 'highlightsTintReset' ? 'highlightsTint'
                        : action.type === 'vibranceReset' ? 'vibrance' : 'saturation']: 0 },
        } });
    }
    case 'toggleWhiteBalance': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: 'whiteBalanceToggle', before: current.recipe },
        recipe: { ...current.recipe, whiteBalanceEnabled: !current.recipe.whiteBalanceEnabled } });
    }
    case 'toggleBasic': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: 'basicToggle', before: current.recipe },
        recipe: { ...current.recipe, basicEnabled: !current.recipe.basicEnabled } });
    }
    case 'toggleColorGrading': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: 'colorGradingToggle', before: current.recipe },
        recipe: { ...current.recipe, colorGradingEnabled: !current.recipe.colorGradingEnabled } });
    }
    case 'toggleGradingShadows':
    case 'toggleGradingMidtones':
    case 'toggleGradingHighlights': {
      const current = commit(state);
      const field = action.type === 'toggleGradingShadows' ? 'gradingShadowsEnabled'
        : action.type === 'toggleGradingMidtones' ? 'gradingMidtonesEnabled' : 'gradingHighlightsEnabled';
      const kind = action.type === 'toggleGradingShadows' ? 'gradingShadowsToggle'
        : action.type === 'toggleGradingMidtones' ? 'gradingMidtonesToggle' : 'gradingHighlightsToggle';
      return commit({ ...current, pending: { kind, before: current.recipe },
        recipe: { ...current.recipe, [field]: !current.recipe[field] } });
    }
    case 'toggleColor': {
      const current = commit(state);
      return commit({ ...current, pending: { kind: 'colorToggle', before: current.recipe },
        recipe: { ...current.recipe, colorEnabled: !current.recipe.colorEnabled } });
    }
  }
}

export function editAsset(sessions: Record<string, EditSession>, id: string, action: EditAction) {
  return { ...sessions, [id]: editSession(sessions[id] ?? newSession(), action) };
}
