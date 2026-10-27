import { RAW_CONTROL_IDS, type RawDocument, type RawSettings, type RawValues } from '../rawApi';

const nrDefaults: Partial<RawValues> = { 'detail.nrDetail': 50, 'detail.nrColorDetail': 50, 'detail.nrColorSmoothness': 50 };

export function rawSettings(doc: RawDocument): RawSettings {
  return { ...doc, settingsFingerprint: doc.settingsFingerprint ?? String(doc.revision).padStart(64, '0'),
    recipeRevision: doc.recipeRevision ?? 0, recipeFingerprint: doc.recipeFingerprint ?? null,
    mutationAttempts: 0, mutationLimit: 256, regenerationThreshold: 200,
    process: 2, wbAutoAvailable: true, wb: { available: true, mode: 'asShot', scale: 'kelvin' }, sections: { light: true, color: true, detail: true },
    values: Object.fromEntries(RAW_CONTROL_IDS.map(id => [id, id === 'wb.temp' ? 6500 : id === 'detail.sharpenAmount' ? 40
      : id === 'detail.nrColor' ? 25 : nrDefaults[id] ?? 0])) as RawValues,
    controls: RAW_CONTROL_IDS.map(id => ({ id, min: id.startsWith('detail.') ? 0 : id === 'wb.temp' ? 2000 : id === 'light.exposure' ? -5 : id === 'wb.tint' ? -150 : -100,
      max: id === 'detail.sharpenAmount' ? 150 : id === 'wb.temp' ? 50000 : id === 'light.exposure' ? 5 : id === 'wb.tint' ? 150 : 100,
      step: id === 'wb.temp' ? 50 : id === 'light.exposure' ? .01 : 1, default: id === 'wb.temp' ? 6500 : nrDefaults[id] ?? 0,
      precision: id === 'light.exposure' ? 2 : 0 })) };
}
