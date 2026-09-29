import { temperatureGains, tintGains } from './adjustmentPipeline';
import { effectiveAdjustments, normalizeTemperature, normalizeTint, normalizeVibrance,
  normalizeSaturation, type EditRecipe } from './editing';
import { prepareGpuRecipe } from './webgpuRecipe';

// Arithmetic model only, never a WGSL executor. GPU pow accuracy and contraction remain hardware-dependent.
export function modelGpuRecipe(source: Uint8ClampedArray, recipe: EditRecipe, singlePrecision: boolean) {
  const f = singlePrecision ? Math.fround : (v: number) => v;
  const add = (a: number, b: number) => f(f(a) + f(b));
  const sub = (a: number, b: number) => f(f(a) - f(b));
  const mul = (a: number, b: number) => f(f(a) * f(b));
  const div = (a: number, b: number) => f(f(a) / f(b));
  const pow = (a: number, b: number) => f(f(a) ** f(b));
  const clip = (x: number) => Math.max(0, Math.min(1, x));
  const byte = (x: number) => Math.floor(add(mul(255, clip(x)), 0.5));
  const smooth = (x: number) => { x = clip(x); return mul(mul(x, x), sub(3, mul(2, x))); };
  const luminance = (c: number[]) => add(add(mul(0.2126, c[0]), mul(0.7152, c[1])), mul(0.0722, c[2]));
  const gainByte = (channel: number, gain: number) => {
    const srgb = div(channel, 255);
    const linear = srgb <= f(0.04045) ? div(srgb, 12.92) : pow(div(add(srgb, 0.055), 1.055), 2.4);
    const shifted = clip(mul(linear, gain));
    return byte(shifted <= f(0.0031308) ? mul(12.92, shifted) : sub(mul(1.055, pow(shifted, f(1 / 2.4))), 0.055));
  };
  const a = effectiveAdjustments(recipe);
  const tone = (n: number) => f(Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) / 100 : 0);
  const tones = [a.highlights, a.whites, a.shadows, a.blacks].map(tone);
  const vibrance = f(normalizeVibrance(a.vibrance) / 100);
  const saturation = f(1 + normalizeSaturation(a.saturation) / 100);
  const grading = [[a.shadowsTemperature, a.shadowsTint], [a.midtonesTemperature, a.midtonesTint],
    [a.highlightsTemperature, a.highlightsTint]].map(([t, m]) => {
    const temperature = normalizeTemperature(t), tint = normalizeTint(m);
    return { temperature, tint, tg: temperatureGains(temperature), mg: tintGains(tint) };
  });
  const { luts } = prepareGpuRecipe(recipe);
  const output = source.slice();
  for (let offset = 0; offset < source.length; offset += 4) {
    let rgb = [source[offset], source[offset + 1], source[offset + 2]];
    for (let stage = 0; stage < 3; stage++) rgb = rgb.map((v, channel) => luts[stage * 1024 + v * 4 + channel]);
    for (let stage = 0; stage < 4; stage++) {
      const amount = tones[stage];
      if (amount === 0) continue;
      const color = rgb.map(v => div(v, 255)), y = luminance(color);
      let target: number;
      if (stage === 0 && y > f(0.5)) {
        const curved = amount > 0 ? sub(1, mul(sub(1, y), sub(1, y))) : mul(y, y);
        target = clip(add(y, mul(mul(Math.abs(amount), smooth(mul(sub(y, 0.5), 2))), sub(curved, y))));
      } else if (stage === 1 && y > f(0.75)) {
        target = clip(add(y, mul(mul(Math.abs(amount), smooth(div(sub(y, 0.75), 1 - 0.75))), sub(amount > 0 ? 1 : 0.75, y))));
      } else if (stage === 2 && y < f(0.15)) {
        const curved = amount > 0 ? f(Math.sqrt(y)) : mul(y, y);
        target = clip(add(y, mul(mul(Math.abs(amount), smooth(div(sub(0.15, y), 0.15))), sub(curved, y))));
      } else if (stage === 3 && y < f(0.35)) {
        target = clip(add(y, mul(mul(amount, 0.1), sub(1, smooth(div(y, 0.35))))));
        if (y <= f(1e-6)) { rgb = [byte(target), byte(target), byte(target)]; continue; }
      } else continue;
      const scale = div(target, stage === 1 || stage === 2 ? Math.max(y, f(1e-6)) : y);
      rgb = color.map(v => byte(mul(v, scale)));
    }
    grading.forEach((g, range) => {
      if (g.temperature === 0 && g.tint === 0) return;
      const y = luminance(rgb.map(v => div(v, 255)));
      const low = smooth(div(sub(y, 0.15), 0.35 - 0.15));
      const weight = range === 0 ? sub(1, low) : range === 1
        ? mul(low, sub(1, smooth(div(sub(y, 0.60), 0.78 - 0.60)))) : smooth(div(sub(y, 0.55), 0.75 - 0.55));
      if (weight <= 0) return;
      if (g.temperature !== 0) { rgb[0] = gainByte(rgb[0], pow(g.tg.red, weight)); rgb[2] = gainByte(rgb[2], pow(g.tg.blue, weight)); }
      if (g.tint !== 0) {
        const rb = pow(g.mg.red, weight);
        rgb = [gainByte(rgb[0], rb), gainByte(rgb[1], pow(g.mg.green, weight)), gainByte(rgb[2], rb)];
      }
    });
    if (vibrance !== 0) {
      const color = rgb.map(v => div(v, 255)), y = luminance(color);
      const chroma = Math.max(...color.map(v => Math.abs(sub(v, y))));
      const weight = sub(1, clip(div(chroma, 0.5)));
      const strength = vibrance > 0 ? mul(0.75, weight) : mul(0.6, add(0.25, mul(1 - 0.25, weight)));
      const factor = add(1, mul(vibrance, strength));
      rgb = color.map(v => byte(add(y, mul(sub(v, y), factor))));
    }
    if (saturation !== 1) {
      const color = rgb.map(v => div(v, 255)), y = luminance(color);
      rgb = color.map(v => byte(add(y, mul(sub(v, y), saturation))));
    }
    output.set(rgb, offset);
  }
  return output;
}
