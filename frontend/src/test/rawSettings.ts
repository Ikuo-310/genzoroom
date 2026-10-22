import { RAW_CONTROL_IDS, type RawDocument, type RawSettings, type RawValues } from '../rawApi';

export function rawSettings(doc: RawDocument): RawSettings {
  return { ...doc, process: 2, wb: { available: true, mode: 'asShot', scale: 'kelvin' },
    values: Object.fromEntries(RAW_CONTROL_IDS.map(id => [id, id === 'wb.temp' ? 6500 : 0])) as RawValues,
    controls: RAW_CONTROL_IDS.map(id => ({ id, min: id === 'wb.temp' ? 2000 : id === 'light.exposure' ? -5 : id === 'wb.tint' ? -150 : -100,
      max: id === 'wb.temp' ? 50000 : id === 'light.exposure' ? 5 : id === 'wb.tint' ? 150 : 100,
      step: id === 'wb.temp' ? 50 : id === 'light.exposure' ? .01 : 1, default: id === 'wb.temp' ? 6500 : 0,
      precision: id === 'light.exposure' ? 2 : 0 })) };
}
