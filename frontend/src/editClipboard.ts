import { ADJUSTMENT_IDS, type AdjustmentId, type EditRecipe } from './editing';
import { RAW_COPY_SETTING_IDS, RAW_DEFAULT_COPY_SETTING_IDS, validRawCopySettingIds,
  type RawCopySettingId, type RawCopySettings, type RawCopySettingsResponse } from './rawApi';

export type JpegEditClipboard = {
  engine: 'jpeg';
  values: Partial<EditRecipe['adjustments']>;
  sourceAssetId: string;
  sourceFilename: string;
};
export type LightcraftEditClipboard = {
  engine: 'lightcraft';
  sourceWbMode: RawCopySettingsResponse['sourceWbMode'];
  sourceAssetId: string;
  sourceFilename: string;
  selectedIds: RawCopySettingId[];
  settings: RawCopySettings;
};
export type EditClipboard = JpegEditClipboard | LightcraftEditClipboard;
export type EditClipboardInfo = { engine: 'jpeg'; selectedIds: AdjustmentId[] } | { engine: 'lightcraft';
  selectedIds: RawCopySettingId[]; sourceWbMode: RawCopySettingsResponse['sourceWbMode'];
  payloadWbMode: RawCopySettingsResponse['sourceWbMode'] };
export type LightcraftWbCompatibility = 'compatible' | 'modeMismatch' | 'modeUnknown';
export const RAW_COPY_SETTING_CATEGORIES = [
  { id: 'basic', labelKey: 'workspace.basic', selectedIds: ['basic.exposure', 'basic.contrast', 'basic.highlights', 'basic.shadows', 'basic.whites', 'basic.blacks'] },
  { id: 'whiteBalance', labelKey: 'workspace.whiteBalance', selectedIds: ['whiteBalance'] },
  { id: 'color', labelKey: 'workspace.rawPreview.colorCategory', selectedIds: ['color.vibrance', 'color.saturation'] },
  { id: 'colorMixer', labelKey: 'workspace.rawPreview.mixer.title', selectedIds: ['colorMixer'] },
  { id: 'pointColor', labelKey: 'workspace.rawPreview.pointColor.title', selectedIds: ['pointColor'] },
  { id: 'colorGrading', labelKey: 'workspace.rawPreview.gradingCategory', selectedIds: ['colorGrading'] },
  { id: 'pointCurve', labelKey: 'workspace.rawPreview.curvesCategory', selectedIds: ['pointCurve'] },
  { id: 'basicEffects', labelKey: 'workspace.rawPreview.basicEffects', selectedIds: ['effects.texture', 'effects.clarity', 'effects.dehaze'] },
  { id: 'vignette', labelKey: 'workspace.rawPreview.vignette', selectedIds: ['vignette'] },
  { id: 'detail', labelKey: 'workspace.rawPreview.detailCategory', selectedIds: ['sharpening', 'luminanceNoiseReduction', 'colorNoiseReduction'] },
  { id: 'lensCorrections', labelKey: 'workspace.rawPreview.lensCorrections', selectedIds: ['lensCorrection', 'chromaticAberration'] },
  { id: 'localToneMapping', labelKey: 'workspace.rawPreview.cameraLocalTone', selectedIds: ['localToneMapping'] },
  { id: 'calibration', labelKey: 'workspace.rawPreview.calibrationCategory', selectedIds: ['calibration'] },
  { id: 'crop', labelKey: 'workspace.rawCrop.crop', selectedIds: ['crop'] },
] as const satisfies readonly { id: string; labelKey: string; selectedIds: readonly RawCopySettingId[] }[];
export const RAW_COPY_SETTING_LABEL_KEYS: Record<RawCopySettingId, string> = {
  'basic.exposure': 'workspace.exposure', 'basic.contrast': 'workspace.contrast', 'basic.highlights': 'workspace.highlights',
  'basic.shadows': 'workspace.shadows', 'basic.whites': 'workspace.whites', 'basic.blacks': 'workspace.blacks',
  whiteBalance: 'workspace.whiteBalance', 'color.vibrance': 'workspace.vibrance', 'color.saturation': 'workspace.saturation',
  colorMixer: 'workspace.rawPreview.mixer.title', pointColor: 'workspace.rawPreview.pointColor.title', colorGrading: 'workspace.rawPreview.gradingCategory',
  pointCurve: 'workspace.copySettingNames.pointCurve', 'effects.texture': 'workspace.rawPreview.texture', 'effects.clarity': 'workspace.rawPreview.clarity',
  'effects.dehaze': 'workspace.rawPreview.dehaze', vignette: 'workspace.copySettingNames.vignette', sharpening: 'workspace.rawPreview.sharpening',
  luminanceNoiseReduction: 'workspace.rawPreview.noiseReduction', colorNoiseReduction: 'workspace.rawPreview.colorNoiseReduction',
  lensCorrection: 'workspace.rawPreview.lensCorrections', chromaticAberration: 'workspace.rawPreview.removeChromaticAberration',
  localToneMapping: 'workspace.rawPreview.cameraLocalTone', calibration: 'workspace.rawPreview.calibrationCategory', crop: 'workspace.copySettingNames.crop',
};

// Selection projection only: Native defaults and validation remain owned by the P1-A/B Backend contract.
const COPY_SETTING_PATHS: Record<RawCopySettingId, readonly (readonly string[])[]> = {
  'basic.exposure': [['light', 'exposure']],
  'basic.contrast': [['light', 'contrast']],
  'basic.highlights': [['light', 'highlights']],
  'basic.shadows': [['light', 'shadows']],
  'basic.whites': [['light', 'whites']],
  'basic.blacks': [['light', 'blacks']],
  whiteBalance: [['wb']],
  'color.vibrance': [['color', 'vibrance']],
  'color.saturation': [['color', 'saturation']],
  colorMixer: [['mixer']],
  pointColor: [['point_colors']],
  colorGrading: [['grading']],
  pointCurve: [['curve']],
  'effects.texture': [['effects', 'texture']],
  'effects.clarity': [['effects', 'clarity']],
  'effects.dehaze': [['effects', 'dehaze']],
  vignette: [['vignette']],
  sharpening: [['detail', 'sharpen_amount'], ['detail', 'sharpen_radius'], ['detail', 'sharpen_detail'], ['detail', 'sharpen_masking']],
  luminanceNoiseReduction: [['detail', 'nr_luminance'], ['detail', 'nr_detail']],
  colorNoiseReduction: [['detail', 'nr_color'], ['detail', 'nr_color_detail'], ['detail', 'nr_color_smoothness']],
  lensCorrection: [['optics', 'distortion'], ['optics', 'vignetting'], ['optics', 'vignetting_midpoint'],
    ['optics', 'profile_distortion'], ['optics', 'profile_vignetting'], ['optics', 'lens_profile']],
  chromaticAberration: [['optics', 'remove_ca'], ['optics', 'defringe_purple_amount'], ['optics', 'defringe_purple_hue_lo'],
    ['optics', 'defringe_purple_hue_hi'], ['optics', 'defringe_green_amount'], ['optics', 'defringe_green_hue_lo'],
    ['optics', 'defringe_green_hue_hi'], ['optics', 'ca_red'], ['optics', 'ca_blue']],
  localToneMapping: [['profile', 'camera_local_tone']],
  calibration: [['calibration']],
  crop: [['crop'], ['orientation']],
};

// Module memory survives route changes within this tab, but never reloads.
let clipboard: EditClipboard | null = null;

export function copyEditSettings(
  recipe: EditRecipe, sourceAssetId: string, sourceFilename: string,
  adjustmentIds: readonly AdjustmentId[] = ADJUSTMENT_IDS,
): void {
  const values: JpegEditClipboard['values'] = {};
  for (const id of adjustmentIds) values[id] = recipe.adjustments[id];
  clipboard = { engine: 'jpeg', values, sourceAssetId, sourceFilename };
}

export function copyLightcraftEditSettings(response: RawCopySettingsResponse, sourceFilename: string): LightcraftEditClipboard {
  if (!validRawCopySettingIds(response.selectedIds) || !response.settings || typeof response.settings !== 'object'
    || response.sourceWbMode !== 'absolute' && response.sourceWbMode !== 'relative' && response.sourceWbMode !== 'unknown'
    || Array.isArray(response.settings) || typeof sourceFilename !== 'string' || sourceFilename.length < 1
    || [...sourceFilename].length > 255 || /[\\/:\u0000-\u001f]/.test(sourceFilename)) throw new Error('raw_invalid_response');
  const copied: LightcraftEditClipboard = { engine: 'lightcraft', sourceAssetId: response.assetId,
    sourceFilename, sourceWbMode: response.sourceWbMode, selectedIds: [...response.selectedIds], settings: structuredClone(response.settings) };
  clipboard = copied;
  return readEditClipboard() as LightcraftEditClipboard;
}

// Callers cannot mutate the stored copy or a later Paste's History metadata.
export function readEditClipboard(): EditClipboard | null {
  if (!clipboard) return null;
  return clipboard.engine === 'jpeg' ? { ...clipboard, values: { ...clipboard.values } }
    : { ...clipboard, selectedIds: [...clipboard.selectedIds], settings: structuredClone(clipboard.settings) };
}
export function editClipboardInfo(): EditClipboardInfo | null {
  if (!clipboard) return null;
  return clipboard.engine === 'jpeg' ? { engine: 'jpeg', selectedIds: Object.keys(clipboard.values) as AdjustmentId[] }
    : { engine: 'lightcraft', selectedIds: [...clipboard.selectedIds], sourceWbMode: clipboard.sourceWbMode,
      payloadWbMode: lightcraftWbPayloadMode(clipboard) };
}

function wbModeForScale(scale: unknown): RawCopySettingsResponse['sourceWbMode'] {
  return scale === 'kelvin' ? 'absolute' : scale === 'legacy' ? 'relative' : 'unknown';
}

export function lightcraftWbPayloadMode(copy: LightcraftEditClipboard): RawCopySettingsResponse['sourceWbMode'] {
  const wb = copy.settings.wb;
  return wb && typeof wb === 'object' && !Array.isArray(wb)
    ? wbModeForScale((wb as Record<string, unknown>).scale) : 'unknown';
}

export function lightcraftWbCompatibility(sourceMode: RawCopySettingsResponse['sourceWbMode'],
  payloadMode: RawCopySettingsResponse['sourceWbMode'], targetMode: RawCopySettingsResponse['sourceWbMode'] | undefined): LightcraftWbCompatibility {
  if (sourceMode === 'unknown' || payloadMode === 'unknown' || targetMode === undefined || targetMode === 'unknown') return 'modeUnknown';
  return sourceMode === payloadMode && payloadMode === targetMode ? 'compatible' : 'modeMismatch';
}

export function isJpegEditClipboard(value: EditClipboard | null | undefined): value is JpegEditClipboard {
  return value?.engine === 'jpeg';
}
export function isLightcraftEditClipboard(value: EditClipboard | null | undefined): value is LightcraftEditClipboard {
  return value?.engine === 'lightcraft';
}
export function jpegEditClipboardValues(value: EditClipboard | null | undefined): JpegEditClipboard['values'] {
  return isJpegEditClipboard(value) ? value.values : {};
}

// Selection is a new payload, never a change to the shared clipboard.
export function selectEditClipboardItems(copy: JpegEditClipboard, ids: readonly AdjustmentId[]): JpegEditClipboard {
  const values: JpegEditClipboard['values'] = {};
  for (const id of ids) if (Object.hasOwn(copy.values, id)) values[id] = copy.values[id];
  return { ...copy, values };
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key))
      throw new Error('raw_invalid_response');
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(target: RawCopySettings, path: readonly string[], value: unknown) {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const existing = current[key];
    if (existing === undefined) current[key] = {};
    else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('raw_invalid_response');
    current = current[key] as RawCopySettings;
  }
  current[path[path.length - 1]] = structuredClone(value);
}

export function selectLightcraftEditClipboardItems(copy: LightcraftEditClipboard,
  ids: readonly RawCopySettingId[]): LightcraftEditClipboard {
  if (!validRawCopySettingIds(ids) || ids.some(id => !copy.selectedIds.includes(id))) throw new Error('raw_invalid_request');
  const settings: RawCopySettings = {};
  for (const id of ids) for (const path of COPY_SETTING_PATHS[id]) setPath(settings, path, getPath(copy.settings, path));
  return { ...copy, selectedIds: [...ids], settings };
}

export { RAW_COPY_SETTING_IDS, RAW_DEFAULT_COPY_SETTING_IDS };
