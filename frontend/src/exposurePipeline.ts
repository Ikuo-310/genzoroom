import type { EditRecipe } from './editing';

// Pure pixel stage: accepts decoded sRGB RGBA, never changes the source buffer.
// Later adjustments belong here, independent of the image acquisition adapter.
export function renderAdjustments(source: Uint8ClampedArray, recipe: EditRecipe): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(source);
  const gain = 2 ** recipe.adjustments.exposure;
  const contrast = Number.isFinite(recipe.adjustments.contrast)
    ? Math.max(-100, Math.min(100, recipe.adjustments.contrast)) : 0;
  const contrastFactor = 1 + contrast / 100;
  const highlights = Number.isFinite(recipe.adjustments.highlights)
    ? Math.max(-100, Math.min(100, recipe.adjustments.highlights)) / 100 : 0;
  const shadows = Number.isFinite(recipe.adjustments.shadows)
    ? Math.max(-100, Math.min(100, recipe.adjustments.shadows)) / 100 : 0;
  if (gain === 1 && contrastFactor === 1 && highlights === 0 && shadows === 0) return output;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const srgb = i / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    const exposed = Math.min(1, linear * gain);
    const exposedSrgb = exposed <= 0.0031308 ? 12.92 * exposed : 1.055 * exposed ** (1 / 2.4) - 0.055;
    const contrasted = Math.max(0, Math.min(1, 0.5 + (exposedSrgb - 0.5) * contrastFactor));
    lut[i] = Math.round(255 * contrasted);
  }
  for (let i = 0; i < output.length; i += 4) {
    output[i] = lut[source[i]];
    output[i + 1] = lut[source[i + 1]];
    output[i + 2] = lut[source[i + 2]];
    if (highlights !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const threshold = Math.max(0, Math.min(1, (luminance - 0.5) * 2));
      const weight = threshold * threshold * (3 - 2 * threshold);
      const curvedLuminance = highlights > 0
        ? 1 - (1 - luminance) ** 2
        : luminance ** 2;
      const targetLuminance = Math.max(0, Math.min(1,
        luminance + Math.abs(highlights) * weight * (curvedLuminance - luminance)));
      const scale = luminance > 0 ? targetLuminance / luminance : 1;
      output[i] = Math.round(255 * Math.max(0, Math.min(1, red * scale)));
      output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, green * scale)));
      output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, blue * scale)));
    }
    if (shadows === 0) continue;

    const red = output[i] / 255;
    const green = output[i + 1] / 255;
    const blue = output[i + 2] / 255;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const threshold = Math.max(0, Math.min(1, (0.25 - luminance) / 0.25));
    const weight = threshold * threshold * (3 - 2 * threshold);
    const targetLuminance = shadows > 0 ? Math.sqrt(luminance) : luminance ** 2;
    const amount = Math.abs(shadows) * weight;
    const adjustedLuminance = Math.max(0, Math.min(1,
      luminance + amount * (targetLuminance - luminance)));
    const scale = adjustedLuminance / Math.max(luminance, 1e-6);
    output[i] = Math.round(255 * Math.max(0, Math.min(1, red * scale)));
    output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, green * scale)));
    output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, blue * scale)));
  }
  return output;
}
