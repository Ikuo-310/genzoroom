"""Selectable copy projection for the currently published GenzoRoom RAW controls."""

import copy
import json
import math
from uuid import UUID

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
MAX_COPY_SETTINGS_BYTES = 64 * 1024
MAX_PASTE_METADATA_BYTES = 1024

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


def validate_selected_ids(selected_ids):
    if (type(selected_ids) is not list or not selected_ids
            or any(type(item) is not str or item not in COPY_SETTING_IDS for item in selected_ids)
            or len(set(selected_ids)) != len(selected_ids)):
        raise LightCraftError("raw_invalid_request")
    return selected_ids


def validate_paste_metadata(metadata):
    if (type(metadata) is not dict or set(metadata) != {"sourceAssetId", "sourceFilename", "selectedIds"}
            or type(metadata.get("sourceAssetId")) is not str
            or type(metadata.get("sourceFilename")) is not str
            or not 1 <= len(metadata["sourceFilename"]) <= 255
            or any(char in metadata["sourceFilename"] for char in "/\\:")
            or any(ord(char) < 32 for char in metadata["sourceFilename"])):
        raise LightCraftError("raw_invalid_request")
    try:
        if str(UUID(metadata["sourceAssetId"])) != metadata["sourceAssetId"]:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise LightCraftError("raw_invalid_request") from None
    validate_selected_ids(metadata["selectedIds"])
    try:
        if len(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_PASTE_METADATA_BYTES:
            raise ValueError()
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise LightCraftError("raw_invalid_request") from None
    return metadata


def _assert_payload_shape(expected, actual, path=()):
    if type(expected) is dict:
        if type(actual) is not dict or set(actual) != set(expected):
            raise LightCraftError("raw_invalid_request")
        for key, value in expected.items():
            _assert_payload_shape(value, actual[key], (*path, key))
    elif type(expected) is list:
        if type(actual) is not list:
            raise LightCraftError("raw_invalid_request")
    elif expected is None and path == ("crop", "aspect"):
        if actual is not None and (type(actual) is not list or len(actual) != 2
                or any(type(value) is not int or not 1 <= value <= 0xffffffff for value in actual)):
            raise LightCraftError("raw_invalid_request")
    elif type(expected) is bool:
        if type(actual) is not bool:
            raise LightCraftError("raw_invalid_request")
    elif type(expected) in (int, float):
        if type(actual) not in (int, float) or type(actual) is float and not math.isfinite(actual):
            raise LightCraftError("raw_invalid_request")
    elif type(expected) is str and type(actual) is not str:
        raise LightCraftError("raw_invalid_request")


def paste_control_ids(selected_ids):
    validate_selected_ids(selected_ids)
    controls = set()
    for selector in selected_ids:
        if selector in _BASIC:
            controls.add(next(key for key, path in CONTROL_PATHS.items() if path == _BASIC[selector]))
        elif selector in CONTROLS:
            controls.add(selector)
        elif selector == "whiteBalance":
            controls.update(("wb.temp", "wb.tint"))
        elif selector == "colorMixer":
            controls.update(key for key in CONTROLS if key.startswith("mixer."))
        elif selector == "colorGrading":
            controls.update(key for key in CONTROLS if key.startswith("grading."))
        elif selector == "vignette":
            controls.update(key for key in CONTROLS if key.startswith("vignette."))
        elif selector == "sharpening":
            controls.update(key for key in CONTROLS if key.startswith("detail.sharpen"))
        elif selector == "luminanceNoiseReduction":
            controls.update(key for key in CONTROLS if key in ("detail.nrLuminance", "detail.nrDetail"))
        elif selector == "colorNoiseReduction":
            controls.update(key for key in CONTROLS if key.startswith("detail.nrColor"))
        elif selector == "lensCorrection":
            controls.update(_LENS_CONTROLS)
        elif selector == "chromaticAberration":
            controls.update(key for key in CONTROLS if key.startswith(("optics.defringe", "optics.ca")))
        elif selector == "calibration":
            controls.update(key for key in CONTROLS if key.startswith("calibration."))
    return controls


def paste_flag_ids(selected_ids):
    validate_selected_ids(selected_ids)
    flags = set()
    if "lensCorrection" in selected_ids:
        flags.add("optics.lens_profile")
    if "chromaticAberration" in selected_ids:
        flags.add("optics.remove_ca")
    if "localToneMapping" in selected_ids:
        flags.add("profile.camera_local_tone")
    return flags


def validate_copy_payload(selected_ids, payload):
    """Translate untrusted partial payload errors into the request boundary's client error."""
    try:
        return _validate_copy_payload(selected_ids, payload)
    except LightCraftError as error:
        if error.code == "raw_invalid_request":
            raise
        raise LightCraftError("raw_invalid_request") from None
    except (OverflowError, TypeError, ValueError, UnicodeError, RecursionError):
        raise LightCraftError("raw_invalid_request") from None


def _validate_copy_payload(selected_ids, payload):
    """Validate an exact P1-A projection before passing it to LightCraft's partial merge."""
    validate_selected_ids(selected_ids)
    if type(payload) is not dict:
        raise LightCraftError("raw_invalid_request")
    try:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise LightCraftError("raw_invalid_request") from None
    if len(encoded) > MAX_COPY_SETTINGS_BYTES:
        raise LightCraftError("raw_invalid_request")

    shape = extract_copy_settings({}, selected_ids)
    _assert_payload_shape(shape, payload)

    from raw_controls import (CONTROLS, CONTROL_PATHS, validate_controls, validate_curve_settings,
                              validate_point_colors, VIGNETTE_STYLES)
    control_ids = paste_control_ids(selected_ids)
    for selector in selected_ids:
        if selector == "whiteBalance":
            if payload["wb"]["mode"] not in ("asShot", "auto", "daylight", "cloudy", "shade", "tungsten",
                                               "fluorescent", "flash", "custom") or payload["wb"]["scale"] not in ("legacy", "kelvin"):
                raise LightCraftError("raw_invalid_request")
        elif selector == "vignette":
            if payload["vignette"]["style"] not in VIGNETTE_STYLES:
                raise LightCraftError("raw_invalid_request")
        elif selector == "pointColor":
            validate_point_colors(payload)
        elif selector == "pointCurve":
            validate_curve_settings(payload)
        elif selector == "crop":
            from raw_geometry import geometry_state
            geometry_state(payload, required=True)

    control_values = {}
    for control in control_ids:
        value, present = _get_path(payload, CONTROL_PATHS[control])
        if not present:
            raise LightCraftError("raw_invalid_request")
        control_values[control] = value
    if control_values:
        validate_controls(control_values, wb_available=True)
    flags = {key: _get_path(payload, CONTROL_PATHS[key])[0] if key.startswith("optics.") else
             payload["profile"]["camera_local_tone"] for key in paste_flag_ids(selected_ids)}
    optics_flags = {key: value for key, value in flags.items() if key.startswith("optics.")}
    if optics_flags:
        validate_controls(optics_flags, wb_available=True)
    if "profile.camera_local_tone" in flags and type(flags["profile.camera_local_tone"]) is not bool:
        raise LightCraftError("raw_invalid_request")
    return payload
