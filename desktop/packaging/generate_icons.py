"""Render the existing GenzoRoom marks into deterministic Windows icon assets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "desktop" / "icons"
BADGE = ROOT / "frontend" / "src" / "GenzoRoomExportBadge.tsx"
BADGE_SVG = ICONS / "export-badge.svg"
LARGE_MARK = ROOT / "design" / "genzo_icon_fix.svg"
SIZES = (16, 24, 32, 48, 64, 128, 256)
SMALL_SIZES = SIZES[:4]
SUPERSAMPLE = 8
BADGE_VIEWBOX = "0 0 24 24"
BADGE_PADDING_RATIO = 2 / 28
BADGE_BACKGROUND = "#a0a4a2"
BADGE_BORDER = "#c8cbca"
BADGE_INK = "#111312"
RENDERER = ROOT / "desktop" / "target" / "icon-renderer" / "release" / "genzoroom-svg-rasterizer.exe"
RENDERER_MANIFEST = ROOT / "desktop" / "packaging" / "icon-renderer" / "Cargo.toml"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def badge_svg(source: str) -> bytes:
    view_box = re.search(r'<svg\b[^>]*\bviewBox="([^"]+)"', source)
    if not view_box or view_box.group(1) != BADGE_VIEWBOX:
        raise ValueError("badge_svg_viewbox_changed")
    paths = re.findall(r"<path\b([^>]*)/>", source)
    if len(paths) != 3:
        raise ValueError("badge_svg_path_count_changed")
    output = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{BADGE_VIEWBOX}" width="24" height="24" fill="{BADGE_INK}">'
    ]
    for attributes in paths:
        attributes = re.sub(r"\bfillRule=", "fill-rule=", attributes)
        if "currentColor" in attributes:
            attributes = attributes.replace("currentColor", BADGE_INK)
        if "fillRule=" in attributes:
            raise ValueError("jsx_fill_rule_not_converted")
        output.append(f"  <path{attributes}/>")
    output.append("</svg>")
    return ("\n".join(output) + "\n").encode("utf-8")


def ensure_renderer() -> Path:
    if RENDERER.exists():
        return RENDERER
    RENDERER.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["cargo", "build", "--locked", "--release", "--manifest-path", str(RENDERER_MANIFEST),
         "--target-dir", str(RENDERER.parent.parent)],
        cwd=ROOT,
        check=True,
    )
    if not RENDERER.exists():
        raise FileNotFoundError("svg_renderer_build_output_missing")
    return RENDERER


def render_svg(renderer: Path, source: Path, output: Path, width: int, height: int,
               padding: float = 0) -> Image.Image:
    subprocess.run(
        [str(renderer), str(source), str(output), str(width), str(height), str(padding)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    with Image.open(output) as image:
        return image.convert("RGBA")


def render_badge(renderer: Path, source_svg: Path, size: int, temporary: Path) -> Image.Image:
    high_size = size * SUPERSAMPLE
    padding = high_size * BADGE_PADDING_RATIO
    glyph = render_svg(renderer, source_svg, temporary, high_size, high_size, padding)
    canvas = Image.new("RGBA", (high_size, high_size), BADGE_BACKGROUND)
    border = Image.new("RGBA", (high_size, high_size), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle(
        (0, 0, high_size - 1, high_size - 1),
        radius=high_size * 4 / 28,
        outline=BADGE_BORDER,
        width=max(1, round(high_size / 28)),
    )
    canvas.alpha_composite(glyph)
    canvas.alpha_composite(border)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def build_ico(frames: list[Image.Image]) -> bytes:
    from io import BytesIO

    encoded = []
    for frame in frames:
        stream = BytesIO()
        frame.save(stream, format="PNG", optimize=False)
        encoded.append(stream.getvalue())
    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    for frame, payload in zip(frames, encoded):
        size = frame.width
        directory.extend(struct.pack("<BBBBHHII", size & 255, size & 255, 0, 0, 1, 32, len(payload), offset))
        offset += len(payload)
    return bytes(directory) + b"".join(encoded)


def render_all(badge_source: bytes, large_source: bytes) -> list[Image.Image]:
    renderer = ensure_renderer()
    with tempfile.TemporaryDirectory(prefix="genzoroom-icon-", dir=ROOT / "desktop" / "packaging") as temporary_dir:
        temporary = Path(temporary_dir)
        badge_path = temporary / "badge.svg"
        large_path = temporary / "large.svg"
        badge_path.write_bytes(badge_source)
        large_path.write_bytes(large_source)
        frames = []
        for size in SIZES:
            if size in SMALL_SIZES:
                frame = render_badge(renderer, badge_path, size, temporary / "badge.png")
            else:
                high_size = size * SUPERSAMPLE
                frame = render_svg(renderer, large_path, temporary / "large.png", high_size, high_size)
                frame = frame.resize((size, size), Image.Resampling.LANCZOS)
            frames.append(frame)
        return frames


def verify(badge_source: bytes, large_source: bytes) -> None:
    expected_svg = badge_svg(BADGE.read_text(encoding="utf-8"))
    if not BADGE_SVG.exists() or BADGE_SVG.read_bytes() != expected_svg:
        raise ValueError("standalone_badge_svg_mismatch")
    if b'fill-rule="evenodd"' not in expected_svg or b"fillRule=" in expected_svg:
        raise ValueError("standalone_badge_fill_rule_mismatch")
    if expected_svg.count(b"<path ") != 3:
        raise ValueError("standalone_badge_path_count_mismatch")
    manifest = json.loads((ICONS / "manifest.json").read_text(encoding="utf-8"))
    if manifest["smallMark"]["sha256"] != sha256(BADGE.read_text(encoding="utf-8").encode("utf-8")):
        raise ValueError("small_icon_source_mismatch")
    if manifest["largeMark"]["sha256"] != sha256(large_source):
        raise ValueError("large_icon_source_mismatch")
    frames = render_all(expected_svg, large_source)
    for size, expected in zip(SIZES, frames):
        path = ICONS / f"icon-{size}.png"
        with Image.open(path) as image:
            if image.size != (size, size) or image.mode != "RGBA":
                raise ValueError(f"invalid_icon_png:{size}")
            if image.tobytes() != expected.tobytes():
                raise ValueError(f"rendered_source_png_mismatch:{size}")
    ico = (ICONS / "icon.ico").read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", ico)
    if (reserved, kind, count) != (0, 1, len(SIZES)):
        raise ValueError("invalid_ico_header")
    entries = [struct.unpack_from("<BBBBHHII", ico, 6 + index * 16) for index in range(count)]
    actual_sizes = tuple(entry[0] or 256 for entry in entries)
    if actual_sizes != SIZES:
        raise ValueError("invalid_ico_sizes")
    for size, entry, expected in zip(SIZES, entries, frames):
        _, _, _, _, planes, bpp, length, offset = entry
        if planes != 1 or bpp != 32 or ico[offset:offset + 8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"invalid_ico_frame:{size}")
        with Image.open(ICONS / f"icon-{size}.png") as png:
            png_bytes = png.tobytes()
        from io import BytesIO
        with Image.open(BytesIO(ico[offset:offset + length])) as frame:
            if frame.size != (size, size) or frame.tobytes() != png_bytes or frame.tobytes() != expected.tobytes():
                raise ValueError(f"ico_frame_mismatch:{size}")
    if manifest["smallMark"]["sizes"] != list(SMALL_SIZES) or manifest["largeMark"]["sizes"] != list(SIZES[4:]):
        raise ValueError("icon_source_mapping_mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    badge_text = BADGE.read_text(encoding="utf-8")
    badge_source = badge_svg(badge_text)
    large_source = LARGE_MARK.read_bytes()
    if args.verify_only:
        verify(badge_source, large_source)
        return
    ICONS.mkdir(parents=True, exist_ok=True)
    BADGE_SVG.write_bytes(badge_source)
    frames = render_all(badge_source, large_source)
    for size, frame in zip(SIZES, frames):
        frame.save(ICONS / f"icon-{size}.png", format="PNG", optimize=False)
    (ICONS / "icon.ico").write_bytes(build_ico(frames))
    manifest = {
        "formatVersion": 2,
        "smallMark": {
            "source": "frontend/src/GenzoRoomExportBadge.tsx",
            "standaloneSvg": "desktop/icons/export-badge.svg",
            "sha256": sha256(badge_text.encode("utf-8")),
            "sizes": list(SMALL_SIZES),
            "pathDataPreserved": True,
            "fillRuleMapping": "fillRule -> fill-rule",
        },
        "largeMark": {"source": "design/genzo_icon_fix.svg", "sha256": sha256(large_source), "sizes": list(SIZES[4:])},
        "ico": {"file": "icon.ico", "sizes": list(SIZES), "frameEncoding": "PNG"},
    }
    (ICONS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify(badge_source, large_source)


if __name__ == "__main__":
    main()
