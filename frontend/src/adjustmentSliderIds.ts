import { ADJUSTMENT_IDS, type AdjustmentId } from './editing';
import { RAW_SETTINGS_CONTROL_IDS, type RawHistoryControlId, type RawPointColorControlId } from './rawApi';

// Slider focus identities also cover RAW controls without extending the JPEG Recipe schema.
export type RawPointColorAdjustmentField = 'hue_shift' | 'sat_shift' | 'lum_shift' | 'variance'
  | 'range' | 'hue_range' | 'sat_range' | 'lum_range';
export type SliderAdjustmentId = AdjustmentId | RawHistoryControlId | RawPointColorControlId | 'crop.angle';
export function sliderAdjustmentId(id: string | undefined): SliderAdjustmentId | null {
  if (id === 'crop.angle') return id;
  if (/^pointColor\.[0-7]\.(?:hueShift|satShift|lumShift|variance|range|hueRange|satRange|lumRange)$/.test(id ?? ''))
    return id as RawPointColorControlId;
  return ADJUSTMENT_IDS.find(candidate => candidate === id) ?? RAW_SETTINGS_CONTROL_IDS.find(candidate => candidate === id) ?? null;
}
export function isJpegAdjustmentId(id: SliderAdjustmentId): id is AdjustmentId {
  return ADJUSTMENT_IDS.some(candidate => candidate === id);
}
