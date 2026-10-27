import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { RAW_CONTROL_IDS, type RawControlId } from './rawApi';

// Slider focus identities also cover RAW controls without extending the JPEG Recipe schema.
export type SliderAdjustmentId = AdjustmentId | RawControlId;
export function sliderAdjustmentId(id: string | undefined): SliderAdjustmentId | null {
  return ADJUSTMENT_IDS.find(candidate => candidate === id) ?? RAW_CONTROL_IDS.find(candidate => candidate === id) ?? null;
}
export function isJpegAdjustmentId(id: SliderAdjustmentId): id is AdjustmentId {
  return ADJUSTMENT_IDS.some(candidate => candidate === id);
}
