"""Standalone RAW artifact generation; no Queue, database or remote writes."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
import json
import ntpath
from pathlib import Path
import re
import struct
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image, ImageCms, ExifTags, TiffImagePlugin

from export_artifact import ExportArtifact, next_export_filename
from edit_store import _json
from raw_recipe_store import MAX_SETTINGS_BYTES
import jpeg_metadata as metadata
from lightcraft_runtime import LightCraftManager, lightcraft_log
from lightcraft_mcp import MCPToolError


MAX_RAW_BYTES = 512 * 1024 * 1024
MAX_JPEG_BYTES = 256 * 1024 * 1024
XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\0"


class RawExportError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def extract_raw_metadata(source):
    """Read bounded standard TIFF/DNG tags, never image strips or MakerNotes."""
    if not isinstance(source, bytes) or not 8 <= len(source) <= MAX_RAW_BYTES:
        raise RawExportError("raw_export_invalid_source")
    if source[:4] not in (b"II*\0", b"MM\0*"):
        raise RawExportError("raw_export_unsupported_metadata_container")
    order = "<" if source[:2] == b"II" else ">"
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}
    root, capture, gps = {}, {}, {}
    xmp = None
    pending = [(struct.unpack_from(order + "I", source, 4)[0], "root")]
    seen = set()
    keep = set(metadata._ROOT_TEXT + metadata._CAPTURE_TEXT + metadata._CAPTURE_RATIONAL +
               metadata._CAPTURE_INT) | {36867, 36881, 37521, 42034, 37380, 34665, 34853, 700}
    while pending:
        offset, group = pending.pop()
        if offset in seen or len(seen) >= 16 or not 8 <= offset <= len(source) - 2:
            raise RawExportError("raw_export_invalid_metadata")
        seen.add(offset)
        count = struct.unpack_from(order + "H", source, offset)[0]
        if count > 4096 or offset + 2 + count * 12 + 4 > len(source):
            raise RawExportError("raw_export_invalid_metadata")
        target = {"root": root, "capture": capture, "gps": gps}[group]
        for position in range(offset + 2, offset + 2 + count * 12, 12):
            tag, kind, number = struct.unpack_from(order + "HHI", source, position)
            if tag not in (metadata._GPS_RULES if group == "gps" else keep):
                continue
            if kind not in sizes or not 0 < number <= 65504:
                continue
            length = sizes[kind] * number
            at = position + 8 if length <= 4 else struct.unpack_from(order + "I", source, position + 8)[0]
            if length > 65504 or at + length > len(source):
                raise RawExportError("raw_export_invalid_metadata")
            raw = source[at:at + length]
            if tag in (34665, 34853) and group == "root":
                if kind != 4 or number != 1:
                    raise RawExportError("raw_export_invalid_metadata")
                pending.append((struct.unpack(order + "I", raw)[0], "capture" if tag == 34665 else "gps"))
                continue
            if tag == 700 and group == "root":
                xmp = raw
                continue
            try:
                if kind == 2:
                    value = raw.rstrip(b"\0").decode("ascii")
                elif kind in (5, 10):
                    fmt = "II" if kind == 5 else "ii"
                    values = [TiffImagePlugin.IFDRational(*struct.unpack_from(order + fmt, raw, i * 8))
                              for i in range(number)]
                    value = values[0] if number == 1 else tuple(values)
                elif kind in (1, 7):
                    value = raw if kind == 7 else (raw[0] if number == 1 else tuple(raw))
                else:
                    values = struct.unpack(order + {3: "H", 4: "I", 9: "i"}[kind] * number, raw)
                    value = values[0] if number == 1 else values
                if tag in target:
                    raise RawExportError("raw_export_invalid_metadata")
                target[tag] = value
            except (UnicodeError, ZeroDivisionError, struct.error):
                metadata._diagnostic("metadata.fields_dropped", fieldCount=1)
    class Fields(dict):
        def get_ifd(self, tag):
            return capture if tag == ExifTags.IFD.Exif else gps if tag == ExifTags.IFD.GPSInfo else {}

    exif = Fields(root)

    class Source:
        def getexif(self):
            return exif

    return (*metadata._preserve_exif(Source()), metadata._preserve_xmp(xmp))


def _optional_source_metadata(source):
    # Metadata support must not decide whether Native can decode this source format.
    if not isinstance(source, bytes) or not 8 <= len(source) <= MAX_RAW_BYTES:
        raise RawExportError("raw_export_invalid_source")
    try:
        if source[:4] in (b"II*\0", b"MM\0*"):
            return extract_raw_metadata(source)
        with Image.open(BytesIO(source)) as image:
            return (*metadata._preserve_exif(image), metadata._preserve_xmp(image.info.get("xmp")))
    except Exception:
        lightcraft_log("export.metadata_unavailable", level="warn", errorCode="raw_export_metadata_unavailable")
        return {}, {}, {}, {}


def _input_filename(filename):
    if not isinstance(filename, str):
        raise RawExportError("invalid_export_filename")
    # Treat both Windows and POSIX separators as untrusted, irrespective of host OS.
    name = ntpath.basename(filename)
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', '_', name).rstrip(' .')
    if not name or name in ('.', '..'):
        raise RawExportError("invalid_export_filename")
    stem, suffix = ntpath.splitext(name)
    if re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', stem):
        stem = 'source_' + stem
    return stem[:128] + suffix


def _metadata_bytes(source, width, height, instant, *, minimal=False):
    if not isinstance(instant, datetime) or instant.tzinfo is None or instant.utcoffset() is None:
        raise RawExportError("invalid_export_timestamp")
    instant = instant.astimezone(timezone.utc)
    root, capture, gps, user_xmp = ({}, {}, {}, {}) if minimal else _optional_source_metadata(source)
    exif = Image.Exif()
    exif.update(root)
    exif.update({305: "GenzoRoom", 274: 1, 306: instant.strftime("%Y:%m:%d %H:%M:%S")})
    capture.update({40962: width, 40963: height, 40961: 1, 36880: "+00:00"})
    exif[ExifTags.IFD.Exif] = capture
    if gps:
        exif[ExifTags.IFD.GPSInfo] = gps
    tree = ET.Element("{adobe:ns:meta/}xmpmeta")
    rdf = ET.SubElement(tree, f"{{{metadata.RDF}}}RDF")
    description = ET.SubElement(rdf, f"{{{metadata.RDF}}}Description", {f"{{{metadata.RDF}}}about": ""})
    date = instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for name, value in (("CreatorTool", "GenzoRoom"), ("ModifyDate", date), ("MetadataDate", date)):
        ET.SubElement(description, f"{{{metadata.XMP}}}{name}").text = value
    for tag, value in sorted(user_xmp.items()):
        field = ET.SubElement(description, tag)
        if isinstance(value, str):
            field.text = value
        else:
            array = ET.SubElement(field, f"{{{metadata.RDF}}}{metadata._DC_ARRAYS[tag.split('}')[1]]}")
            for language, text in value:
                ET.SubElement(array, f"{{{metadata.RDF}}}li", {metadata.XML_LANG: language} if language else {}).text = text
    encoded, xml = exif.tobytes(), ET.tostring(tree, encoding="utf-8")
    if len(encoded) > metadata.MAX_EXIF_BYTES or len(xml) > metadata.MAX_XMP_BYTES:
        if minimal:
            raise RawExportError("metadata_too_large")
        lightcraft_log("export.metadata_reduced", level="warn", errorCode="metadata_too_large")
        return _metadata_bytes(source, width, height, instant, minimal=True)
    return encoded, xml


@dataclass(frozen=True)
class _JpegLayout:
    width: int
    height: int
    # Byte ranges retain scan/table/ICC data without copying full compressed buffers.
    segments: tuple


def _parse_jpeg(jpeg):
    if not isinstance(jpeg, bytes) or not 4 <= len(jpeg) <= MAX_JPEG_BYTES or jpeg[:2] != b"\xff\xd8":
        raise RawExportError("raw_export_invalid_jpeg")
    position, frame, scans = 2, None, 0
    segments, profiles = [], {}
    profile_count = None
    try:
        while position < len(jpeg):
            start = position
            if jpeg[position] != 255:
                raise ValueError
            while position < len(jpeg) and jpeg[position] == 255:
                position += 1
            if position >= len(jpeg):
                raise ValueError
            marker = jpeg[position]
            position += 1
            if marker == 0xD9:
                if position != len(jpeg) or frame is None or not scans:
                    raise ValueError
                segments.append((marker, position, start, position))
                break
            if marker in (0, 0xD8) or 0xD0 <= marker <= 0xD7 or position + 2 > len(jpeg):
                raise ValueError
            length = int.from_bytes(jpeg[position:position + 2], "big")
            payload, end = position + 2, position + length
            if length < 2 or end > len(jpeg):
                raise ValueError
            segments.append((marker, payload, start, end))
            if marker in (0xC0, 0xC1, 0xC2):
                data = jpeg[payload:end]
                if frame is not None or len(data) != 15 or data[0] != 8 or data[5] != 3 or any(data[i] != 0x11 for i in (7, 10, 13)):
                    raise ValueError
                height, width = int.from_bytes(data[1:3], "big"), int.from_bytes(data[3:5], "big")
                if not width or not height:
                    raise ValueError
                frame = width, height
            if marker == 0xE2 and jpeg.startswith(b"ICC_PROFILE\0", payload):
                if end - payload < 14:
                    raise ValueError
                index, count = jpeg[payload + 12:payload + 14]
                if not 1 <= index <= count or index in profiles or profile_count not in (None, count):
                    raise ValueError
                profile_count = count
                profiles[index] = jpeg[payload + 14:end]
            position = end
            if marker == 0xDA:
                if frame is None or end - payload < 6 or jpeg[payload] not in (1, 2, 3) or end - payload != 4 + 2 * jpeg[payload]:
                    raise ValueError
                scans += 1
                scan_start = position
                # Locate scan boundaries only; entropy and coding tables belong to Native.
                while True:
                    at = jpeg.find(b"\xff", position)
                    if at < 0:
                        raise ValueError
                    following = at + 1
                    while following < len(jpeg) and jpeg[following] == 255:
                        following += 1
                    if following >= len(jpeg):
                        raise ValueError
                    code = jpeg[following]
                    if code == 0 or 0xD0 <= code <= 0xD7:
                        position = following + 1
                        continue
                    if at == scan_start:
                        raise ValueError
                    segments.append((0, scan_start, scan_start, at))
                    position = at
                    break
        else:
            raise ValueError
        if profile_count is None or len(profiles) != profile_count:
            raise ValueError
        icc = b"".join(profiles[i] for i in range(1, profile_count + 1))
        if len(icc) > 1024 * 1024:
            raise ValueError
        if ImageCms.ImageCmsProfile(BytesIO(icc)).profile.xcolor_space.strip() != "RGB":
            raise ValueError
        return _JpegLayout(*frame, tuple(segments))
    except Exception as error:
        raise RawExportError("raw_export_invalid_jpeg") from error


def _segments(jpeg):
    # Inspection helper for regression tools; production uses byte ranges directly.
    for marker, payload, start, end in _parse_jpeg(jpeg).segments:
        yield marker, jpeg[payload:end], jpeg[start:end]


def inspect_export_jpeg(jpeg):
    layout = _parse_jpeg(jpeg)
    return layout.width, layout.height


def create_raw_export_artifact(source, jpeg, source_filename, family_filenames, *, timestamp,
                               expected_dimensions=None):
    """Validate once and replace APP1; all other bytes are copied unchanged."""
    layout = _parse_jpeg(jpeg)
    if expected_dimensions is not None and (layout.width, layout.height) != expected_dimensions:
        raise RawExportError("raw_export_invalid_output")
    exif, xmp = _metadata_bytes(source, layout.width, layout.height, timestamp)
    def app1(payload):
        return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    parts = [b"\xff\xd8", app1(exif), app1(XMP_HEADER + xmp)]
    view = memoryview(jpeg)
    for marker, payload, start, end in layout.segments:
        if marker == 0xE1 and (jpeg.startswith(b"Exif\0\0", payload) or jpeg.startswith(XMP_HEADER, payload)):
            continue
        parts.append(view[start:end])
    if sum(len(part) for part in parts) > MAX_JPEG_BYTES:
        raise RawExportError("raw_export_invalid_output")
    return ExportArtifact(next_export_filename(source_filename, family_filenames), b"".join(parts))


@dataclass(frozen=True)
class RawExportInput:
    source: bytes
    source_filename: str
    family_filenames: tuple[str, ...]
    settings: dict
    timestamp: datetime
    expected_content_hash: str | None = None


async def export_raw_artifact(request: RawExportInput, *, manager=None, temp_root=None):
    """P2 boundary: caller owns saved snapshot selection; this call owns isolated Native state."""
    if not isinstance(request.settings, dict):
        raise RawExportError("raw_export_invalid_settings")
    # Freeze before the first await; callers may continue editing their own settings object.
    try:
        encoded_settings = _json(request.settings)
        if len(encoded_settings.encode("utf-8")) > MAX_SETTINGS_BYTES:
            raise ValueError
        settings = json.loads(encoded_settings)
    except (TypeError, ValueError, RecursionError) as error:
        raise RawExportError("raw_export_invalid_settings") from error
    source = bytes(request.source)
    family_filenames = tuple(request.family_filenames)
    if not 8 <= len(source) <= MAX_RAW_BYTES:
        raise RawExportError("raw_export_invalid_source")
    input_filename = _input_filename(request.source_filename)
    owned = (manager or LightCraftManager()).diagnostic_manager(
        manager._gpu_backend if manager is not None else "dx12")
    lightcraft_log("export.started", sourceBytes=len(source))
    try:
        with tempfile.TemporaryDirectory(prefix="genzoroom-raw-export-", dir=temp_root) as directory:
            input_directory = Path(directory) / "input"
            input_directory.mkdir()
            original = input_directory / input_filename
            output = Path(directory) / "output.jpg"
            original.write_bytes(source)
            try:
                await owned.start()
                async with asyncio.timeout(20):
                    while owned.status().state not in ("ready", "failed", "disabled"):
                        await asyncio.sleep(.01)
                if owned.status().state != "ready" or not owned.artifact_info():
                    raise RawExportError("raw_export_engine_unavailable")
                client = owned._ready_client()
                async def tool(name, arguments):
                    result = await client.call_tool_result(name, arguments, timeout=120)
                    if "structuredContent" in result:
                        return result["structuredContent"]
                    text = result["content"][0]["text"]
                    return None if text == "ok" else json.loads(text)
                async def command(name, params):
                    return await tool("command_run", {"id": name, "params": params})
                await command("library.xmpPreferences", {"autoWrite": False})
                try:
                    imported = await tool("import", {"paths": [str(original)], "mode": "add"})
                except MCPToolError as error:
                    raise RawExportError("raw_export_source_unreadable") from error
                ids = imported.get("imported") if isinstance(imported, dict) else None
                if not isinstance(ids, list) or len(ids) != 1 or type(ids[0]) is not int:
                    raise RawExportError("raw_export_invalid_import")
                photo = ids[0]
                await tool("select_photos", {"ids": [photo], "active": photo})
                if request.expected_content_hash is not None:
                    # Bind the frozen Recipe to its input; output byte determinism is unrelated.
                    info = await command("photo.inspect", {"id": photo})
                    if not isinstance(info, dict) or info.get("content_hash") != request.expected_content_hash:
                        raise RawExportError("raw_export_source_mismatch")
                await command("develop.reset", {"ids": [photo]})
                await command("develop.merge", {"settings": settings})
                if await tool("get_develop", {"id": photo}) != settings:
                    raise RawExportError("raw_export_settings_mismatch")
                result = await tool("export", {"id": photo, "path": str(output), "format": "jpeg", "longEdge": 0,
                    "quality": 95, "colorSpace": "srgb", "bitDepth": 8, "hdr": False, "sharpen": "none",
                    "metadata": "none", "addToPhotos": False})
                if output.is_symlink() or not output.is_file() or output.stat().st_size > MAX_JPEG_BYTES:
                    raise RawExportError("raw_export_invalid_output")
                jpeg = output.read_bytes()
                if await tool("get_develop", {"id": photo}) != settings:
                    raise RawExportError("raw_export_settings_mismatch")
                artifact = create_raw_export_artifact(source, jpeg, request.source_filename,
                    family_filenames, timestamp=request.timestamp,
                    expected_dimensions=(result.get("width"), result.get("height")))
                lightcraft_log("export.completed", artifactBytes=len(artifact.jpeg))
                return artifact
            finally:
                # Reap Native before deleting its source/output files, including cancellation.
                await owned.close()
    except MCPToolError as error:
        lightcraft_log("export.failed", level="error", errorCode="raw_export_native_failed")
        raise RawExportError("raw_export_native_failed") from error
    except BaseException:
        lightcraft_log("export.failed", level="error", errorCode="raw_export_failed")
        raise
