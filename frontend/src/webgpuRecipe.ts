import { renderAdjustments, temperatureGains, tintGains } from './adjustmentPipeline';
import { defaultRecipe, effectiveAdjustments, EXPOSURE, normalizeTemperature, normalizeTint,
  normalizeVibrance, normalizeSaturation, type EditRecipe } from './editing';

export function prepareGpuRecipe(recipe: EditRecipe) {
  if (recipe.version !== 18) throw new Error('Unsupported GPU Recipe version');
  const a = effectiveAdjustments(recipe);
  if (!Number.isFinite(a.exposure) || a.exposure < EXPOSURE.min || a.exposure > EXPOSURE.max) {
    throw new RangeError('Invalid exposure');
  }
  const ramp = Uint8ClampedArray.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4));
  const luts = new Uint8Array(3 * 1024);
  // Keep CPU byte boundaries, including Temperature before Tint and the combined Exposure/Contrast LUT.
  // Only 256 code values per stage run on CPU; image pixels are processed by WGSL.
  for (const [stage, adjustments] of [
    { temperature: a.temperature }, { tint: a.tint }, { exposure: a.exposure, contrast: a.contrast },
  ].entries()) {
    const stageRecipe = defaultRecipe();
    Object.assign(stageRecipe.adjustments, adjustments);
    luts.set(renderAdjustments(ramp, stageRecipe), stage * 1024);
  }
  const tone = (value: number) => Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) / 100 : 0;
  const grading = [
    [a.shadowsTemperature, a.shadowsTint], [a.midtonesTemperature, a.midtonesTint],
    [a.highlightsTemperature, a.highlightsTint],
  ].map(([temperature, tint]) => {
    const t = normalizeTemperature(temperature), m = normalizeTint(tint);
    const tg = temperatureGains(t), mg = tintGains(m);
    return { temperature: t, tint: m, gains: [tg.red, tg.blue, mg.red, mg.green] };
  });
  // vec4-aligned uniform: header, tones, color/flags, then one gain vector per 3WAY range.
  const parameters = new ArrayBuffer(96);
  const view = new DataView(parameters);
  const put = (offset: number, values: number[]) => values.forEach((value, i) => view.setFloat32(offset + i * 4, value, true));
  put(16, [tone(a.highlights), tone(a.whites), tone(a.shadows), tone(a.blacks)]);
  put(32, [normalizeVibrance(a.vibrance) / 100, 1 + normalizeSaturation(a.saturation) / 100]);
  let flags = 0;
  grading.forEach((range, i) => {
    if (range.temperature !== 0) flags |= 1 << (i * 2);
    if (range.tint !== 0) flags |= 1 << (i * 2 + 1);
    put(48 + i * 16, range.gains);
  });
  view.setUint32(40, flags, true);
  return { parameters, luts };
}
