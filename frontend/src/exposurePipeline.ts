import type { EditRecipe } from './editing';

// Pure pixel stage: accepts decoded sRGB RGBA, never changes the source buffer.
// Later adjustments belong here, independent of the image acquisition adapter.
export function renderAdjustments(source: Uint8ClampedArray, recipe: EditRecipe): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(source);
  const gain = 2 ** recipe.adjustments.exposure;
  if (gain === 1) return output;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const srgb = i / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    const exposed = Math.min(1, linear * gain);
    lut[i] = Math.round(255 * (exposed <= 0.0031308 ? 12.92 * exposed : 1.055 * exposed ** (1 / 2.4) - 0.055));
  }
  for (let i = 0; i < output.length; i += 4) {
    output[i] = lut[source[i]];
    output[i + 1] = lut[source[i + 1]];
    output[i + 2] = lut[source[i + 2]];
  }
  return output;
}
