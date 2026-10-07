"""Recipe v18 byte stages, ported from frontend/src/adjustmentPipeline.ts."""

import numpy as np

from edit_state import RECIPE_VERSION, _recipe
from rendered_image import RenderedImage

# Float64 and separate operations preserve the JS stage arithmetic and rounding boundaries.
_SRGB = np.arange(256, dtype=np.float64) / 255
_DECODE = np.where(_SRGB <= 0.04045, _SRGB / 12.92, ((_SRGB + 0.055) / 1.055) ** 2.4)
_CHUNK_PIXELS = 16384
_GROUPS = {
    "whiteBalanceEnabled": ("temperature", "tint"),
    "basicEnabled": ("exposure", "contrast", "highlights", "whites", "shadows", "blacks"),
    "colorGradingEnabled": ("shadowsTemperature", "shadowsTint", "midtonesTemperature",
                            "midtonesTint", "highlightsTemperature", "highlightsTint"),
    "gradingShadowsEnabled": ("shadowsTemperature", "shadowsTint"),
    "gradingMidtonesEnabled": ("midtonesTemperature", "midtonesTint"),
    "gradingHighlightsEnabled": ("highlightsTemperature", "highlightsTint"),
    "colorEnabled": ("vibrance", "saturation"),
}


def _bytes(values):
    clipped = np.clip(values, 0, 255)
    integer = np.floor(clipped)
    # JS Math.round chooses the upper integer at a tie, unlike NumPy's ties-to-even.
    # Comparing the fraction also avoids rounding x + 0.5 prematurely near a tie.
    return (integer + (clipped - integer >= 0.5)).astype(np.uint8)


def _encode(linear):
    shifted = np.clip(linear, 0, 1)
    return np.where(shifted <= 0.0031308, 12.92 * shifted,
                    1.055 * shifted ** (1 / 2.4) - 0.055)


def _gain(channel, gain):
    return _bytes(255 * _encode(_DECODE[channel] * gain))


def _smooth(position):
    position = np.clip(position, 0, 1)
    return position * position * (3 - 2 * position)


def _channels(pixels):
    rgb = pixels.astype(np.float64) / 255
    luminance = 0.2126 * rgb[:, 0] + 0.7152 * rgb[:, 1] + 0.0722 * rgb[:, 2]
    return rgb, luminance


def _tone(pixels, name, amount):
    rgb, luminance = _channels(pixels)
    if name == "highlights":
        active = luminance > 0.5
        weight = _smooth((luminance - 0.5) * 2)
        target = 1 - (1 - luminance) ** 2 if amount > 0 else luminance ** 2
        adjusted = np.clip(luminance + abs(amount) * weight * (target - luminance), 0, 1)
    elif name == "whites":
        active = luminance > 0.75
        weight = _smooth((luminance - 0.75) / (1 - 0.75))
        target = 1 if amount > 0 else 0.75
        adjusted = np.clip(luminance + abs(amount) * weight * (target - luminance), 0, 1)
    elif name == "shadows":
        active = luminance < 0.15
        weight = _smooth((0.15 - luminance) / 0.15)
        target = np.sqrt(luminance) if amount > 0 else luminance ** 2
        adjusted = np.clip(luminance + (abs(amount) * weight) * (target - luminance), 0, 1)
    else:
        active = luminance < 0.35
        weight = 1 - _smooth(luminance / 0.35)
        adjusted = np.clip(luminance + amount * 0.1 * weight, 0, 1)
    scale = adjusted / np.maximum(luminance, 1e-6)
    result = _bytes(255 * np.clip(rgb * scale[:, None], 0, 1))
    if name == "blacks":
        neutral = luminance <= 1e-6
        result[neutral] = _bytes(255 * adjusted[neutral])[:, None]
    pixels[active] = result[active]


def _grade(pixels, scope, temperature, tint):
    _, luminance = _channels(pixels)
    if scope == "shadows":
        weight = 1 - _smooth((luminance - 0.15) / (0.35 - 0.15))
    elif scope == "midtones":
        weight = _smooth((luminance - 0.15) / (0.35 - 0.15)) \
            * (1 - _smooth((luminance - 0.60) / (0.78 - 0.60)))
    else:
        weight = _smooth((luminance - 0.55) / (0.75 - 0.55))
    active = weight > 0
    # Both members of a pair use the pre-Temperature weight, even after byte clipping.
    if temperature:
        for channel, sign in ((0, -1), (2, 1)):
            gain = (1.5 ** (sign * temperature / 100)) ** weight
            pixels[active, channel] = _gain(pixels[active, channel], gain[active])
    if tint:
        for channel, sign in ((0, 1), (1, -1), (2, 1)):
            gain = (1.3 ** (sign * tint / 100)) ** weight
            pixels[active, channel] = _gain(pixels[active, channel], gain[active])


class JpegRenderer:
    """Consumes normalized RGB bytes; acquisition and JPEG compression remain separate."""

    def render(self, source: RenderedImage, recipe: dict) -> RenderedImage:
        # Reuse the saved-data validator rather than creating a divergent Recipe dialect.
        validated = _recipe(recipe, RECIPE_VERSION)
        adjustments = dict(validated["adjustments"])
        for flag, keys in _GROUPS.items():
            if not validated[flag]:
                for key in keys:
                    adjustments[key] = 0
        for key, enabled in validated["adjustmentEnabled"].items():
            if not enabled:
                adjustments[key] = 0
        if not any(adjustments.values()):
            return RenderedImage(source.width, source.height, source.pixels)

        channels = np.arange(256, dtype=np.uint8)
        luts = np.tile(channels, (3, 1))
        temperature, tint = adjustments["temperature"], adjustments["tint"]
        if temperature:
            luts[0] = _gain(luts[0], 1.5 ** (-temperature / 100))
            luts[2] = _gain(luts[2], 1.5 ** (temperature / 100))
        if tint:
            for channel, sign in ((0, 1), (1, -1), (2, 1)):
                luts[channel] = _gain(luts[channel], 1.3 ** (sign * tint / 100))
        exposed = _encode(_DECODE * (2 ** adjustments["exposure"]))
        contrasted = np.clip(0.5 + (exposed - 0.5) * (1 + adjustments["contrast"] / 100), 0, 1)
        basic_lut = _bytes(255 * contrasted)
        luts = basic_lut[luts]

        # Only byte input/output scale with image size. Float temporaries are capped by
        # a pixel chunk (including unusually wide images), not a full-resolution plane.
        source_pixels = np.frombuffer(source.pixels, dtype=np.uint8).reshape(-1, 3)
        output = bytearray(len(source.pixels))
        output_pixels = np.frombuffer(output, dtype=np.uint8).reshape(-1, 3)
        for start in range(0, len(source_pixels), _CHUNK_PIXELS):
            original = source_pixels[start:start + _CHUNK_PIXELS]
            pixels = output_pixels[start:start + _CHUNK_PIXELS]
            for channel in range(3):
                pixels[:, channel] = luts[channel, original[:, channel]]
            for name in ("highlights", "whites", "shadows", "blacks"):
                if adjustments[name]:
                    _tone(pixels, name, adjustments[name] / 100)
            for scope in ("shadows", "midtones", "highlights"):
                temp, tint = adjustments[f"{scope}Temperature"], adjustments[f"{scope}Tint"]
                if temp or tint:
                    _grade(pixels, scope, temp, tint)
            vibrance = adjustments["vibrance"]
            if vibrance:
                rgb, luminance = _channels(pixels)
                chroma = np.max(np.abs(rgb - luminance[:, None]), axis=1)
                low_weight = 1 - np.clip(chroma / 0.5, 0, 1)
                strength = 0.75 * low_weight if vibrance > 0 else 0.6 * (0.25 + (1 - 0.25) * low_weight)
                factor = 1 + vibrance / 100 * strength
                pixels[:] = _bytes(255 * np.clip(luminance[:, None] + (rgb - luminance[:, None]) * factor[:, None], 0, 1))
            if adjustments["saturation"]:
                rgb, luminance = _channels(pixels)
                factor = 1 + adjustments["saturation"] / 100
                pixels[:] = _bytes(255 * np.clip(luminance[:, None] + (rgb - luminance[:, None]) * factor, 0, 1))
        return RenderedImage(source.width, source.height, bytes(output))
