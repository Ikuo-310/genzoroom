import type { EditRecipe } from './editing';

const WHITES_START_LUMINANCE = 0.75;
const BLACKS_FADE_END_LUMINANCE = 0.35;
const BLACKS_MAX_OFFSET = 0.1;

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
  const whites = Number.isFinite(recipe.adjustments.whites)
    ? Math.max(-100, Math.min(100, recipe.adjustments.whites)) / 100 : 0;
  const shadows = Number.isFinite(recipe.adjustments.shadows)
    ? Math.max(-100, Math.min(100, recipe.adjustments.shadows)) / 100 : 0;
  const blacks = Number.isFinite(recipe.adjustments.blacks)
    ? Math.max(-100, Math.min(100, recipe.adjustments.blacks)) / 100 : 0;
  if (gain === 1 && contrastFactor === 1 && highlights === 0 && whites === 0 && shadows === 0 && blacks === 0) return output;
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
    if (whites !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const threshold = Math.max(0, Math.min(1,
        (luminance - WHITES_START_LUMINANCE) / (1 - WHITES_START_LUMINANCE)));
      const weight = threshold * threshold * (3 - 2 * threshold);
      const targetLuminance = whites > 0 ? 1 : WHITES_START_LUMINANCE;
      const adjustedLuminance = Math.max(0, Math.min(1,
        luminance + Math.abs(whites) * weight * (targetLuminance - luminance)));
      const scale = adjustedLuminance / Math.max(luminance, 1e-6);
      output[i] = Math.round(255 * Math.max(0, Math.min(1, red * scale)));
      output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, green * scale)));
      output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, blue * scale)));
    }
    if (shadows !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const threshold = Math.max(0, Math.min(1, (0.15 - luminance) / 0.15));
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
    if (blacks === 0) continue;

    const red = output[i] / 255;
    const green = output[i + 1] / 255;
    const blue = output[i + 2] / 255;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const threshold = Math.max(0, Math.min(1, luminance / BLACKS_FADE_END_LUMINANCE));
    const weight = 1 - threshold * threshold * (3 - 2 * threshold);
    const adjustedLuminance = Math.max(0, Math.min(1,
      luminance + blacks * BLACKS_MAX_OFFSET * weight));
    if (luminance <= 1e-6) {
      const neutral = Math.round(255 * adjustedLuminance);
      output[i] = neutral;
      output[i + 1] = neutral;
      output[i + 2] = neutral;
      continue;
    }
    const scale = adjustedLuminance / luminance;
    output[i] = Math.round(255 * Math.max(0, Math.min(1, red * scale)));
    output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, green * scale)));
    output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, blue * scale)));
  }
  return output;
}
