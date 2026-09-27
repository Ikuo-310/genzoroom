import {
  WHITE_BALANCE_ADJUSTMENT_KEYS, BASIC_ADJUSTMENT_KEYS, COLOR_ADJUSTMENT_KEYS,
  COLOR_GRADING_ADJUSTMENT_KEYS, GRADING_RANGE_CONTROLS, type AdjustmentId,
} from './editing';

type SelectionGroup = { label?: string; ids: readonly AdjustmentId[] };
export type AdjustmentCategoryId = 'whiteBalance' | 'basic' | 'color' | 'colorGrading';
type SelectionCategory = { id: AdjustmentCategoryId; label: string; ids: readonly AdjustmentId[]; groups: SelectionGroup[] };

// Category membership belongs to editing.ts. This adds only selection UI grouping.
export const ADJUSTMENT_SELECTION_CATEGORIES: SelectionCategory[] = [
  { id: 'whiteBalance', label: 'workspace.whiteBalance', ids: WHITE_BALANCE_ADJUSTMENT_KEYS,
    groups: [{ ids: WHITE_BALANCE_ADJUSTMENT_KEYS }] },
  { id: 'basic', label: 'workspace.basic', ids: BASIC_ADJUSTMENT_KEYS,
    groups: [{ ids: BASIC_ADJUSTMENT_KEYS }] },
  { id: 'color', label: 'workspace.color', ids: COLOR_ADJUSTMENT_KEYS,
    groups: [{ ids: COLOR_ADJUSTMENT_KEYS }] },
  { id: 'colorGrading', label: 'workspace.colorGrading', ids: COLOR_GRADING_ADJUSTMENT_KEYS,
    groups: GRADING_RANGE_CONTROLS.map(({ label, ids }) => ({ label, ids })) },
];

export function adjustmentSelectionLabel(id: AdjustmentId): string {
  if (COLOR_GRADING_ADJUSTMENT_KEYS.some((key) => key === id)) {
    return id.endsWith('Temperature') ? 'workspace.temperature' : 'workspace.tint';
  }
  return `workspace.${id}`;
}
