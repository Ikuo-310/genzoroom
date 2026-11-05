import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { RAW_SETTINGS_CONTROL_IDS, type RawHistoryControlId } from './rawApi';

// Slider focus identities also cover RAW controls without extending the JPEG Recipe schema.
export type SliderAdjustmentId = AdjustmentId | RawHistoryControlId | 'crop.angle';
export function sliderAdjustmentId(id: string | undefined): SliderAdjustmentId | null {
  if (id === 'crop.angle') return id;
  return ADJUSTMENT_IDS.find(candidate => candidate === id) ?? RAW_SETTINGS_CONTROL_IDS.find(candidate => candidate === id) ?? null;
}
export function isJpegAdjustmentId(id: SliderAdjustmentId): id is AdjustmentId {
  return ADJUSTMENT_IDS.some(candidate => candidate === id);
}
