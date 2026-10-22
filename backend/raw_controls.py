"""C2 allowlist from LightCraft v0.10.0 develop/src/controls.rs; never JPEG Recipe values."""

import math

from lightcraft_mcp import LightCraftError

CONTROLS = {
    "light.exposure": (-5, 5, .01, 0, 2),
    **{f"light.{key}": (-100, 100, 1, 0, 0)
       for key in ("contrast", "highlights", "shadows", "whites", "blacks")},
    "wb.temp": (2000, 50000, 50, 6500, 0),
    "wb.tint": (-150, 150, 1, 0, 0),
    "color.vibrance": (-100, 100, 1, 0, 0),
    "color.saturation": (-100, 100, 1, 0, 0),
}


def controls_state(snapshot):
    settings = snapshot.settings
    values = {}
    for control in CONTROLS:
        section, key = control.split(".")
        value = settings.get(section, {}).get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise LightCraftError("raw_invalid_settings")
        values[control] = value
    wb = settings.get("wb", {})
    return {"values": values, "controls": [dict(id=key, min=v[0], max=v[1], step=v[2], default=v[3], precision=v[4])
                                           for key, v in CONTROLS.items()],
            "wb": {"available": snapshot.wb_kelvin and wb.get("scale") == "kelvin",
                   "mode": wb.get("mode", "asShot"), "scale": wb.get("scale", "legacy")}, "process": settings["process"]}


def validate_controls(values, wb_available):
    if not isinstance(values, dict) or not 1 <= len(values) <= len(CONTROLS):
        raise LightCraftError("raw_invalid_controls")
    for key, value in values.items():
        if key not in CONTROLS or type(value) not in (int, float) or not math.isfinite(value):
            raise LightCraftError("raw_invalid_controls")
        lo, hi, *_ = CONTROLS[key]
        if not lo <= value <= hi:
            raise LightCraftError("raw_invalid_controls")
        if key.startswith("wb.") and not wb_available:
            raise LightCraftError("raw_wb_unavailable")
    return values
