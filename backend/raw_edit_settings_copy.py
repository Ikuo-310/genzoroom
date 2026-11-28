"""Selectable copy projection for the currently published GenzoRoom RAW controls."""

import copy

from lightcraft_mcp import LightCraftError
from raw_controls import (CONTROLS, CONTROL_PATHS, CURVE_CHANNELS, CURVE_SETTING_FIELDS,
                          VIGNETTE_STYLES)


def _controls(prefixes):
    return {control for control in CONTROLS if any(control.startswith(prefix) for prefix in prefixes)}


_BASIC = {f"basic.{name}": ("light", field) for name, field in {
    "exposure": "exposure", "contrast": "contrast", "highlights": "highlights",
    "shadows": "shadows", "whites": "whites", "blacks": "blacks"}.items()}
_SELECTORS = {
    **_BASIC,
    "color.vibrance": CONTROL_PATHS["color.vibrance"],
    "color.saturation": CONTROL_PATHS["color.saturation"],
    **{control: CONTROL_PATHS[control] for control in _controls(("effects.",))},
    "whiteBalance": ("wb",),
    "colorMixer": ("mixer",),
    "pointColor": ("point_colors",),
    "colorGrading": ("grading",),
    "pointCurve": ("curve",),
    "vignette": ("vignette",),
    "sharpening": ("detail", "sharpen"),
    "luminanceNoiseReduction": ("detail", "luminance_nr"),
    "colorNoiseReduction": ("detail", "color_nr"),
    "lensCorrection": ("optics", "lens"),
    "chromaticAberration": ("optics", "chromatic_aberration"),
    "localToneMapping": ("profile", "camera_local_tone"),
    "calibration": ("calibration",),
    "crop": ("crop",),
}
COPY_SETTING_IDS = frozenset(_SELECTORS)
CROP_SETTING_ID = "crop"

_NUMERIC_DEFAULTS = {key: value[3] for key, value in CONTROLS.items()}
_WB_DEFAULTS = {"mode": "asShot", "scale": "legacy", "temp": 6500.0, "tint": 0.0}
_CURVE_DEFAULTS = {"highlights": 0.0, "lights": 0.0, "darks": 0.0, "shadows": 0.0,
                   "split_shadows": 25.0, "split_mid": 50.0, "split_highlights": 75.0,
                   **{channel: [] for channel in CURVE_CHANNELS}, "refine_saturation": 100.0}
_LENS_CONTROLS = ("optics.distortion", "optics.vignetting", "optics.vignettingMidpoint",
                  "optics.profileDistortion", "optics.profileVignetting")
_LENS_FIELDS = {CONTROL_PATHS[key][1]: _NUMERIC_DEFAULTS[key] for key in _LENS_CONTROLS}
_LENS_FIELDS["lens_profile"] = False
_CA_FIELDS = {CONTROL_PATHS[key][1]: _NUMERIC_DEFAULTS[key] for key in CONTROLS
              if key.startswith(("optics.defringe", "optics.ca"))}
_CA_FIELDS["remove_ca"] = False
_VIGNETTE_DEFAULTS = {CONTROL_PATHS[key][1]: _NUMERIC_DEFAULTS[key] for key in CONTROLS
                      if key.startswith("vignette.")}
_VIGNETTE_DEFAULTS["style"] = VIGNETTE_STYLES[0]


def _get_path(settings, path):
    value = settings
    for key in path:
        if type(value) is not dict:
            return None, False
        if key not in value:
            return None, False
        value = value[key]
    return value, True


def _put_path(target, path, value):
    current = target
    for key in path[:-1]:
        current = current.setdefault(key, {})
    current[path[-1]] = copy.deepcopy(value)


def extract_copy_settings(settings, selected_ids):
    """Return only selected published settings, keeping Native values and array order intact."""
    if type(settings) is not dict or type(selected_ids) is not list or not selected_ids:
        raise LightCraftError("raw_invalid_request")
    if any(type(item) is not str or item not in COPY_SETTING_IDS for item in selected_ids):
        raise LightCraftError("raw_invalid_request")
    if len(set(selected_ids)) != len(selected_ids):
        raise LightCraftError("raw_invalid_request")

    result = {}
    for selector in selected_ids:
        if selector == "crop":
            for key in ("crop", "orientation"):
                value, present = _get_path(settings, (key,))
                if present:
                    result[key] = copy.deepcopy(value)
            if "crop" not in result:
                result["crop"] = {"geometry": {"rect": {"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0},
                                                   "angle": 0.0},
                                  "aspect": None, "flip_h": False, "flip_v": False}
            result.setdefault("orientation", "Normal")
            continue
        if (selector in _BASIC or selector in ("color.vibrance", "color.saturation")
                or selector.startswith("effects.")):
            path = _SELECTORS[selector]
            value, present = _get_path(settings, path)
            control = selector if selector in CONTROLS else next(
                (key for key, control_path in CONTROL_PATHS.items() if control_path == path), None)
            _put_path(result, path, value if present else _NUMERIC_DEFAULTS[control])
            continue
        if selector == "whiteBalance":
            value, present = _get_path(settings, ("wb",))
            if present and type(value) is not dict:
                raise LightCraftError("raw_invalid_settings")
            group = dict(_WB_DEFAULTS)
            if present:
                group.update({key: copy.deepcopy(value[key]) for key in _WB_DEFAULTS if key in value})
            result["wb"] = group
        elif selector == "colorMixer":
            value, present = _get_path(settings, ("mixer",))
            if present and type(value) is not dict:
                raise LightCraftError("raw_invalid_settings")
            group = {}
            for color in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"):
                source = value.get(color, {}) if present else {}
                if type(source) is not dict:
                    raise LightCraftError("raw_invalid_settings")
                group[color] = {field: copy.deepcopy(source.get(field, 0.0)) for field in ("hue", "sat", "lum")}
            result["mixer"] = group
        elif selector == "pointColor":
            value, present = _get_path(settings, ("point_colors",))
            if present and type(value) is not list:
                raise LightCraftError("raw_invalid_settings")
            result["point_colors"] = copy.deepcopy(value if present else [])
        elif selector == "colorGrading":
            value, present = _get_path(settings, ("grading",))
            if present and type(value) is not dict:
                raise LightCraftError("raw_invalid_settings")
            names = ("shadows", "midtones", "highlights")
            if present and any(type(value.get(band, {})) is not dict for band in names):
                raise LightCraftError("raw_invalid_settings")
            result["grading"] = {
                **{band: {field: copy.deepcopy(value.get(band, {}).get(field, 0.0)) if present else 0.0
                          for field in ("hue", "sat", "lum")} for band in names},
                "blending": copy.deepcopy(value.get("blending", 50.0)) if present else 50.0,
                "balance": copy.deepcopy(value.get("balance", 0.0)) if present else 0.0,
            }
        elif selector == "pointCurve":
            value, present = _get_path(settings, ("curve",))
            if present and (type(value) is not dict or set(value) != CURVE_SETTING_FIELDS):
                raise LightCraftError("raw_invalid_settings")
            result["curve"] = copy.deepcopy(value if present else _CURVE_DEFAULTS)
        elif selector == "vignette":
            value, present = _get_path(settings, ("vignette",))
            if present and type(value) is not dict:
                raise LightCraftError("raw_invalid_settings")
            result["vignette"] = {key: copy.deepcopy(value[key]) if present and key in value else default
                                   for key, default in _VIGNETTE_DEFAULTS.items()}
        elif selector in ("sharpening", "luminanceNoiseReduction", "colorNoiseReduction"):
            fields = ({"sharpen_amount", "sharpen_radius", "sharpen_detail", "sharpen_masking"}
                      if selector == "sharpening" else
                      {"nr_luminance", "nr_detail", "nr_contrast"} if selector == "luminanceNoiseReduction" else
                      {"nr_color", "nr_color_detail", "nr_color_smoothness"})
            result.setdefault("detail", {})
            for field in fields:
                key = next((name for name, path in CONTROL_PATHS.items()
                            if path == ("detail", field)), None)
                if key is None and field == "nr_contrast":
                    continue
                value, present = _get_path(settings, ("detail", field))
                result["detail"][field] = copy.deepcopy(value) if present else _NUMERIC_DEFAULTS[key]
        elif selector in ("lensCorrection", "chromaticAberration"):
            values = _LENS_FIELDS if selector == "lensCorrection" else _CA_FIELDS
            result["optics"] = result.get("optics", {})
            source, present = _get_path(settings, ("optics",))
            if present and type(source) is not dict:
                raise LightCraftError("raw_invalid_settings")
            result["optics"].update({key: copy.deepcopy(source[key]) if present and key in source else default
                                     for key, default in values.items()})
        elif selector == "localToneMapping":
            value, present = _get_path(settings, ("profile", "camera_local_tone"))
            result.setdefault("profile", {})["camera_local_tone"] = copy.deepcopy(value) if present else False
        elif selector == "calibration":
            source, present = _get_path(settings, ("calibration",))
            if present and type(source) is not dict:
                raise LightCraftError("raw_invalid_settings")
            result["calibration"] = {}
            for key, path in CONTROL_PATHS.items():
                if key.startswith("calibration."):
                    field = path[1]
                    result["calibration"][field] = copy.deepcopy(source[field]) if present and field in source else _NUMERIC_DEFAULTS[key]
    return result
