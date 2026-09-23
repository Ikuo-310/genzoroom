import { normalizeMidtonesTemperature, normalizeMidtonesTint, normalizeSaturation, normalizeShadowsTemperature, normalizeShadowsTint, normalizeTemperature, normalizeTint, normalizeVibrance, effectiveAdjustments, type EditRecipe } from './editing';

const WHITES_START_LUMINANCE = 0.75;
const BLACKS_FADE_END_LUMINANCE = 0.35;
const BLACKS_MAX_OFFSET = 0.1;
export const TINT_GAIN_BASE = 1.3;
export const VIBRANCE_CHROMA_THRESHOLD = 0.5;
export const VIBRANCE_POSITIVE_STRENGTH = 0.75;
export const VIBRANCE_NEGATIVE_STRENGTH = 0.6;
export const VIBRANCE_NEGATIVE_HIGH_CHROMA_WEIGHT = 0.25;
export const SHADOWS_GRADING_FULL_STRENGTH_END = 0.15;
export const SHADOWS_GRADING_FADE_END = 0.35;
export const MIDTONES_GRADING_FADE_IN_START = 0.15;
export const MIDTONES_GRADING_FULL_STRENGTH_START = 0.35;
export const MIDTONES_GRADING_FULL_STRENGTH_END = 0.60;
export const MIDTONES_GRADING_FADE_OUT_END = 0.78;

// Relative JPEG preview white balance: reciprocal gains, with Green as reference.
export function temperatureGains(value: number) {
  const shift = normalizeTemperature(value) / 100;
  return { red: 1.5 ** -shift, green: 1, blue: 1.5 ** shift };
}

// Reciprocal gains keep equal positive/negative Tint magnitudes perceptually balanced.
export function tintGains(value: number) {
  const shift = normalizeTint(value) / 100;
  return { red: TINT_GAIN_BASE ** shift, green: TINT_GAIN_BASE ** -shift, blue: TINT_GAIN_BASE ** shift };
}

function linearGainLut(gain: number) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const srgb = i / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    const shifted = Math.max(0, Math.min(1, linear * gain));
    const encoded = shifted <= 0.0031308 ? 12.92 * shifted : 1.055 * shifted ** (1 / 2.4) - 0.055;
    lut[i] = Math.round(255 * encoded);
  }
  return lut;
}

export function shadowsGradingWeight(luminance: number) {
  const position = Math.max(0, Math.min(1,
    (luminance - SHADOWS_GRADING_FULL_STRENGTH_END)
      / (SHADOWS_GRADING_FADE_END - SHADOWS_GRADING_FULL_STRENGTH_END)));
  return 1 - position * position * (3 - 2 * position);
}

export function midtonesGradingWeight(luminance: number) {
  const lowPosition = Math.max(0, Math.min(1,
    (luminance - MIDTONES_GRADING_FADE_IN_START)
      / (MIDTONES_GRADING_FULL_STRENGTH_START - MIDTONES_GRADING_FADE_IN_START)));
  const highPosition = Math.max(0, Math.min(1,
    (luminance - MIDTONES_GRADING_FULL_STRENGTH_END)
      / (MIDTONES_GRADING_FADE_OUT_END - MIDTONES_GRADING_FULL_STRENGTH_END)));
  const low = lowPosition * lowPosition * (3 - 2 * lowPosition);
  const high = 1 - highPosition * highPosition * (3 - 2 * highPosition);
  return low * high;
}

// Stage inputs are rounded bytes. Float64 retains the exact original decode results
// while avoiding up to five repeated decode powers per Shadows pixel.
const srgbDecode = Float64Array.from({ length: 256 }, (_, channel) => {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
});

function maskedLinearGain(channel: number, gain: number, weight: number) {
  const linear = srgbDecode[channel];
  const shifted = Math.max(0, Math.min(1, linear * gain ** weight));
  const encoded = shifted <= 0.0031308 ? 12.92 * shifted : 1.055 * shifted ** (1 / 2.4) - 0.055;
  return Math.round(255 * encoded);
}

// Pure adjustment pipeline: accepts decoded sRGB RGBA, never changes the source buffer.
// Later adjustments belong here, independent of the image acquisition adapter.
export function renderAdjustments(source: Uint8ClampedArray, recipe: EditRecipe): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(source);
  const adjustments = effectiveAdjustments(recipe);
  const temperature = normalizeTemperature(adjustments.temperature);
  const tint = normalizeTint(adjustments.tint);
  const gain = 2 ** adjustments.exposure;
  const contrast = Number.isFinite(adjustments.contrast)
    ? Math.max(-100, Math.min(100, adjustments.contrast)) : 0;
  const contrastFactor = 1 + contrast / 100;
  const highlights = Number.isFinite(adjustments.highlights)
    ? Math.max(-100, Math.min(100, adjustments.highlights)) / 100 : 0;
  const whites = Number.isFinite(adjustments.whites)
    ? Math.max(-100, Math.min(100, adjustments.whites)) / 100 : 0;
  const shadows = Number.isFinite(adjustments.shadows)
    ? Math.max(-100, Math.min(100, adjustments.shadows)) / 100 : 0;
  const blacks = Number.isFinite(adjustments.blacks)
    ? Math.max(-100, Math.min(100, adjustments.blacks)) / 100 : 0;
  const shadowsTemperature = normalizeShadowsTemperature(adjustments.shadowsTemperature);
  const shadowsTint = normalizeShadowsTint(adjustments.shadowsTint);
  const midtonesTemperature = normalizeMidtonesTemperature(adjustments.midtonesTemperature);
  const midtonesTint = normalizeMidtonesTint(adjustments.midtonesTint);
  const vibrance = normalizeVibrance(adjustments.vibrance);
  const saturation = normalizeSaturation(adjustments.saturation);
  const saturationFactor = 1 + saturation / 100;
  if (temperature === 0 && tint === 0 && gain === 1 && contrastFactor === 1 && highlights === 0 && whites === 0 && shadows === 0 && blacks === 0 && shadowsTemperature === 0 && shadowsTint === 0 && midtonesTemperature === 0 && midtonesTint === 0 && vibrance === 0 && saturation === 0) return output;
  const temperatureGain = temperatureGains(temperature);
  const tintGain = tintGains(tint);
  const shadowsTemperatureGain = temperatureGains(shadowsTemperature);
  const shadowsTintGain = tintGains(shadowsTint);
  const midtonesTemperatureGain = temperatureGains(midtonesTemperature);
  const midtonesTintGain = tintGains(midtonesTint);
  // Clip and round each active White Balance stage to sRGB bytes before the unchanged Exposure/Contrast LUT.
  // At zero, skip that stage's round-trip to retain existing byte compatibility.
  const redTemperature = temperature !== 0 ? linearGainLut(temperatureGain.red) : null;
  const blueTemperature = temperature !== 0 ? linearGainLut(temperatureGain.blue) : null;
  // Tint is a separate linear-light stage after Temperature, with the same safe clip/encode boundary.
  const redTint = tint !== 0 ? linearGainLut(tintGain.red) : null;
  const greenTint = tint !== 0 ? linearGainLut(tintGain.green) : null;
  const blueTint = tint !== 0 ? linearGainLut(tintGain.blue) : null;
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
    const temperatureRed = redTemperature ? redTemperature[source[i]] : source[i];
    const temperatureBlue = blueTemperature ? blueTemperature[source[i + 2]] : source[i + 2];
    output[i] = lut[redTint ? redTint[temperatureRed] : temperatureRed];
    output[i + 1] = lut[greenTint ? greenTint[source[i + 1]] : source[i + 1]];
    output[i + 2] = lut[blueTint ? blueTint[temperatureBlue] : temperatureBlue];
    // Skip only the inactive stage; later adjustments still use its unchanged bytes.
    if (highlights !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance > 0.5) {
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
    }
    if (whites !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance > WHITES_START_LUMINANCE) {
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
    }
    if (shadows !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance < 0.15) {
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
    }
    if (blacks !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance < BLACKS_FADE_END_LUMINANCE) {
        const threshold = Math.max(0, Math.min(1, luminance / BLACKS_FADE_END_LUMINANCE));
        const weight = 1 - threshold * threshold * (3 - 2 * threshold);
        const adjustedLuminance = Math.max(0, Math.min(1,
          luminance + blacks * BLACKS_MAX_OFFSET * weight));
        if (luminance <= 1e-6) {
          const neutral = Math.round(255 * adjustedLuminance);
          output[i] = neutral;
          output[i + 1] = neutral;
          output[i + 2] = neutral;
        } else {
          const scale = adjustedLuminance / luminance;
          output[i] = Math.round(255 * Math.max(0, Math.min(1, red * scale)));
          output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, green * scale)));
          output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, blue * scale)));
        }
      }
    }
    if (shadowsTemperature !== 0 || shadowsTint !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const weight = shadowsGradingWeight(luminance);
      if (weight > 0) {
        if (shadowsTemperature !== 0) {
          output[i] = maskedLinearGain(output[i], shadowsTemperatureGain.red, weight);
          output[i + 2] = maskedLinearGain(output[i + 2], shadowsTemperatureGain.blue, weight);
        }
        if (shadowsTint !== 0) {
          output[i] = maskedLinearGain(output[i], shadowsTintGain.red, weight);
          output[i + 1] = maskedLinearGain(output[i + 1], shadowsTintGain.green, weight);
          output[i + 2] = maskedLinearGain(output[i + 2], shadowsTintGain.blue, weight);
        }
      }
    }
    if (midtonesTemperature !== 0 || midtonesTint !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const weight = midtonesGradingWeight(luminance);
      if (weight > 0) {
        if (midtonesTemperature !== 0) {
          output[i] = maskedLinearGain(output[i], midtonesTemperatureGain.red, weight);
          output[i + 2] = maskedLinearGain(output[i + 2], midtonesTemperatureGain.blue, weight);
        }
        if (midtonesTint !== 0) {
          output[i] = maskedLinearGain(output[i], midtonesTintGain.red, weight);
          output[i + 1] = maskedLinearGain(output[i + 1], midtonesTintGain.green, weight);
          output[i + 2] = maskedLinearGain(output[i + 2], midtonesTintGain.blue, weight);
        }
      }
    }
    if (vibrance !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const chroma = Math.max(
        Math.abs(red - luminance),
        Math.abs(green - luminance),
        Math.abs(blue - luminance),
      );
      const lowSaturationWeight = 1 - Math.max(0, Math.min(1, chroma / VIBRANCE_CHROMA_THRESHOLD));
      const strength = vibrance > 0
        ? VIBRANCE_POSITIVE_STRENGTH * lowSaturationWeight
        : VIBRANCE_NEGATIVE_STRENGTH * (VIBRANCE_NEGATIVE_HIGH_CHROMA_WEIGHT
          + (1 - VIBRANCE_NEGATIVE_HIGH_CHROMA_WEIGHT) * lowSaturationWeight);
      const factor = 1 + vibrance / 100 * strength;
      output[i] = Math.round(255 * Math.max(0, Math.min(1, luminance + (red - luminance) * factor)));
      output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, luminance + (green - luminance) * factor)));
      output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, luminance + (blue - luminance) * factor)));
    }
    if (saturation !== 0) {
      const red = output[i] / 255;
      const green = output[i + 1] / 255;
      const blue = output[i + 2] / 255;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      output[i] = Math.round(255 * Math.max(0, Math.min(1, luminance + (red - luminance) * saturationFactor)));
      output[i + 1] = Math.round(255 * Math.max(0, Math.min(1, luminance + (green - luminance) * saturationFactor)));
      output[i + 2] = Math.round(255 * Math.max(0, Math.min(1, luminance + (blue - luminance) * saturationFactor)));
    }
  }
  return output;
}
