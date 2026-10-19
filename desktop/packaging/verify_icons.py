"""Fail the distribution build if source sizes or the embedded Windows icon frames drift."""
import argparse
from pathlib import Path
import struct

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {16, 24, 32, 48, 64, 128, 256}


def verify_pe_icon(path: Path) -> None:
    import pefile

    pe = pefile.PE(str(path), fast_load=False)
    try:
        groups = [entry for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries if entry.id == 14]
    except (AttributeError, StopIteration) as error:
        raise RuntimeError(f"windows_icon_resource_missing:{path.name}") from error
    sizes = set()
    for group in groups:
        pending = list(group.directory.entries)
        while pending:
            entry = pending.pop()
            if hasattr(entry, "directory"):
                pending.extend(entry.directory.entries)
                continue
            data = pe.get_data(entry.data.struct.OffsetToData, entry.data.struct.Size)
            if len(data) < 6:
                continue
            reserved, kind, count = struct.unpack_from("<HHH", data)
            if reserved != 0 or kind != 1:
                continue
            for index in range(count):
                width, height = struct.unpack_from("<BB", data, 6 + index * 14)
                sizes.add(width or 256)
                sizes.add(height or 256)
    if not EXPECTED.issubset(sizes):
        raise RuntimeError(f"embedded_icon_sizes_missing:{path.name}:{sorted(EXPECTED - sizes)}")
    pe.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=Path)
    parser.add_argument("--installer", type=Path)
    args = parser.parse_args()
    subprocess_result = __import__("subprocess").run(
        [__import__("sys").executable, str(ROOT / "desktop/packaging/generate_icons.py"), "--verify-only"],
        cwd=ROOT, check=False)
    if subprocess_result.returncode:
        raise RuntimeError("generated_icon_verification_failed")
    for size in sorted(EXPECTED):
        with Image.open(ROOT / f"desktop/icons/icon-{size}.png") as image:
            if image.size != (size, size) or image.mode != "RGBA":
                raise RuntimeError(f"invalid_png_icon:{size}")
    ico = (ROOT / "desktop/icons/icon.ico").read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", ico)
    if reserved != 0 or kind != 1 or count != len(EXPECTED):
        raise RuntimeError("invalid_ico_frame_count")
    dimensions = {entry[0] or 256 for entry in (
        struct.unpack_from("<BBBBHHII", ico, 6 + index * 16) for index in range(count))}
    if dimensions != EXPECTED:
        raise RuntimeError("invalid_ico_dimensions")
    for executable in (args.host, args.installer):
        if executable:
            verify_pe_icon(executable)


if __name__ == "__main__":
    main()
