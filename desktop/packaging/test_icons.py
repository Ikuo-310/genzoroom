"""Check that every ICO frame keeps its assigned original design and dimensions."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "desktop" / "icons"
SIZES = (16, 24, 32, 48, 64, 128, 256)
HISTORIC_SVG_SHA256 = "323c57f85ff3f619cb732312c75146de89115bee2058eac88c384883d50cda3a"


class WindowsIconTests(unittest.TestCase):
    def test_source_assignment_is_split_at_the_required_sizes(self):
        manifest = json.loads((ICONS / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["smallMark"]["sizes"], [16, 24, 32, 48])
        self.assertEqual(manifest["largeMark"]["sizes"], [64, 128, 256])
        self.assertEqual(manifest["largeMark"]["sha256"], HISTORIC_SVG_SHA256)
        self.assertEqual(
            hashlib.sha256((ROOT / "design/genzo_icon_fix.svg").read_bytes()).hexdigest(),
            HISTORIC_SVG_SHA256,
        )
        self.assertEqual(manifest["smallMark"]["sha256"], hashlib.sha256(
            (ROOT / "frontend/src/GenzoRoomExportBadge.tsx").read_text(encoding="utf-8").encode("utf-8")).hexdigest())

    def test_standalone_badge_preserves_source_path_data_and_fill_rule(self):
        source = (ROOT / "frontend/src/GenzoRoomExportBadge.tsx").read_text(encoding="utf-8")
        standalone = (ICONS / "export-badge.svg").read_text(encoding="utf-8")
        source_viewbox = re.search(r'<svg\b[^>]*\bviewBox="([^"]+)"', source)
        output_viewbox = re.search(r'<svg\b[^>]*\bviewBox="([^"]+)"', standalone)
        self.assertIsNotNone(source_viewbox)
        self.assertEqual(output_viewbox.group(1), source_viewbox.group(1))
        source_paths = re.findall(r"<path\b([^>]*)/>", source)
        output_paths = re.findall(r"<path\b([^>]*)/>", standalone)
        self.assertEqual(len(source_paths), 3)
        self.assertEqual(output_paths, [attributes.replace("fillRule=", "fill-rule=") for attributes in source_paths])
        self.assertIn('fill-rule="evenodd"', standalone)
        self.assertIn('fill="#111312"', standalone)
        self.assertNotIn("currentColor", standalone)

    def test_pngs_and_multisize_ico_contain_the_exact_generated_frames(self):
        ico_path = ICONS / "icon.ico"
        with Image.open(ico_path) as icon:
            self.assertEqual(set(icon.ico.sizes()), {(size, size) for size in SIZES})
            for size in SIZES:
                with icon.ico.getimage((size, size)) as frame, Image.open(ICONS / f"icon-{size}.png") as png:
                    self.assertEqual(frame.size, (size, size))
                    self.assertEqual(frame.convert("RGBA").tobytes(), png.convert("RGBA").tobytes())
        with Image.open(ICONS / "icon-16.png") as small, Image.open(ICONS / "icon-64.png") as large:
            self.assertNotEqual(small.resize((64, 64)).tobytes(), large.tobytes())

    def test_generator_verification_is_reproducible(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "desktop/packaging/generate_icons.py"), "--verify-only"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
