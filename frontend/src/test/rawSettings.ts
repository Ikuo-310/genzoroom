import { RAW_SETTINGS_CONTROL_IDS, type RawDocument, type RawSettings, type RawSettingControlId, type RawValues } from '../rawApi';

const controlDefaults: Partial<RawValues> = { 'detail.nrDetail': 50, 'detail.nrColorDetail': 50, 'detail.nrColorSmoothness': 50,
  'grading.blending': 50, 'vignette.midpoint': 50, 'vignette.feather': 50, 'optics.profileDistortion': 100,
  'optics.profileVignetting': 100, 'optics.vignettingMidpoint': 50, 'optics.defringePurpleHueLo': 30,
  'optics.defringePurpleHueHi': 70, 'optics.defringeGreenHueLo': 40, 'optics.defringeGreenHueHi': 60 };
const opticsSpecs: Partial<Record<RawSettingControlId, readonly [number, number, number]>> = {
  'optics.distortion': [-100, 100, 0], 'optics.vignetting': [-100, 100, 0], 'optics.vignettingMidpoint': [0, 100, 50],
  'optics.profileDistortion': [0, 200, 100], 'optics.profileVignetting': [0, 200, 100],
  'optics.defringePurple': [0, 20, 0], 'optics.defringePurpleHueLo': [0, 90, 30], 'optics.defringePurpleHueHi': [10, 100, 70],
  'optics.defringeGreen': [0, 20, 0], 'optics.defringeGreenHueLo': [0, 90, 40], 'optics.defringeGreenHueHi': [10, 100, 60],
  'optics.caRed': [-100, 100, 0], 'optics.caBlue': [-100, 100, 0],
};

export function rawSettings(doc: RawDocument): RawSettings {
  return { ...doc, settingsFingerprint: doc.settingsFingerprint ?? String(doc.revision).padStart(64, '0'),
    curve: { master: [], red: [], green: [], blue: [] },
    recipeRevision: doc.recipeRevision ?? 0, recipeFingerprint: doc.recipeFingerprint ?? null,
    importDefaultsFingerprint: doc.importDefaultsFingerprint ?? 'b'.repeat(64),
    mutationAttempts: 0, mutationLimit: 256, regenerationThreshold: 200,
    process: 2, vignetteStyle: 'highlightPriority', opticsFlags: { remove_ca: false, lens_profile: false },
    lensProfileInfo: { cameraMake: null, cameraModel: null, lensMake: null, lensModel: null, lensId: null,
      profileAvailable: null, profileSource: 'unknown', profileName: null, profileApplied: false },
    wbAutoAvailable: true, wb: { available: true, mode: 'asShot', scale: 'kelvin' }, sections: { light: true, color: true, grading: true, effects: true, detail: true, optics: true },
    values: Object.fromEntries(RAW_SETTINGS_CONTROL_IDS.map(id => [id, id === 'wb.temp' ? 6500 : id === 'detail.sharpenAmount' ? 40
      : id === 'detail.nrColor' ? 25 : controlDefaults[id] ?? 0])) as RawValues,
    controls: RAW_SETTINGS_CONTROL_IDS.map(id => {
      const optics = opticsSpecs[id];
      return { id, min: optics?.[0] ?? (id.startsWith('grading.') && !id.endsWith('.lum') && id !== 'grading.balance' ? 0 : id.startsWith('detail.') || ['vignette.midpoint', 'vignette.feather', 'vignette.highlights'].includes(id) ? 0 : id === 'wb.temp' ? 2000 : id === 'light.exposure' ? -5 : id === 'wb.tint' ? -150 : -100),
        max: optics?.[1] ?? (id.endsWith('.hue') ? 360 : id === 'detail.sharpenAmount' ? 150 : id === 'wb.temp' ? 50000 : id === 'light.exposure' ? 5 : id === 'wb.tint' ? 150 : 100),
        step: id === 'wb.temp' ? 50 : id === 'light.exposure' ? .01 : 1, default: optics?.[2] ?? (id === 'wb.temp' ? 6500 : controlDefaults[id] ?? 0),
        precision: id === 'light.exposure' ? 2 : 0 };
    }) };
}
