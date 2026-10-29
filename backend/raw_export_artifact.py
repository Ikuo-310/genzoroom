"""Standalone RAW artifact generation; no Queue, database or remote writes."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
import struct
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image, ImageCms, ExifTags, TiffImagePlugin

from export_artifact import ExportArtifact, next_export_filename
import jpeg_metadata as metadata
from lightcraft_runtime import LightCraftManager, lightcraft_log


MAX_RAW_BYTES = 512 * 1024 * 1024
MAX_JPEG_BYTES = 256 * 1024 * 1024
MAX_PIXELS = 100_000_000
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


def _metadata_bytes(source, width, height, instant):
    if not isinstance(instant, datetime) or instant.tzinfo is None or instant.utcoffset() is None:
        raise RawExportError("invalid_export_timestamp")
    instant = instant.astimezone(timezone.utc)
    root, capture, gps, user_xmp = extract_raw_metadata(source)
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
        raise RawExportError("metadata_too_large")
    return encoded, xml


def _segments(jpeg):
    metadata._repair_jpeg_exif(jpeg)
    position = 2
    while position < len(jpeg):
        start = position
        while jpeg[position] == 255:
            position += 1
        marker = jpeg[position]
        position += 1
        if marker in (0xDA, 0xD9):
            if marker == 0xDA:
                scan = position + int.from_bytes(jpeg[position:position + 2], "big")
                while scan < len(jpeg):
                    scan = jpeg.find(b"\xff", scan)
                    if scan < 0 or scan + 1 >= len(jpeg):
                        raise RawExportError("raw_export_invalid_jpeg")
                    following = jpeg[scan + 1]
                    if following == 0 or 0xD0 <= following <= 0xD7:
                        scan += 2
                        continue
                    # Native produces one baseline scan; reject trailing metadata/extra scans.
                    if jpeg[scan:] != b"\xff\xd9":
                        raise RawExportError("raw_export_invalid_jpeg")
                    break
            yield marker, b"", jpeg[start:]
            return
        length = int.from_bytes(jpeg[position:position + 2], "big")
        end = position + length
        yield marker, jpeg[position + 2:end], jpeg[start:end]
        position = end


def inspect_export_jpeg(jpeg):
    if not isinstance(jpeg, bytes) or not 4 <= len(jpeg) <= MAX_JPEG_BYTES:
        raise RawExportError("raw_export_invalid_jpeg")
    try:
        segments = list(_segments(jpeg))
        frames = [p for m, p, _ in segments if m == 0xC0]
        if len(frames) != 1:
            raise ValueError
        frame = frames[0]
        height, width = int.from_bytes(frame[1:3], "big"), int.from_bytes(frame[3:5], "big")
        if frame[0] != 8 or frame[5] != 3 or any(frame[i] != 0x11 for i in (7, 10, 13)) or width * height > MAX_PIXELS:
            raise ValueError
        with Image.open(BytesIO(jpeg)) as image:
            if image.format != "JPEG" or image.mode != "RGB" or image.size != (width, height):
                raise ValueError
            icc = image.info.get("icc_profile")
            if not isinstance(icc, bytes) or len(icc) > 1024 * 1024:
                raise ValueError
            profile = ImageCms.ImageCmsProfile(BytesIO(icc))
            if profile.profile.xcolor_space.strip() != "RGB" or "srgb" not in ImageCms.getProfileDescription(profile).lower():
                raise ValueError
        return width, height
    except Exception as error:
        raise RawExportError("raw_export_invalid_jpeg") from error


def create_raw_export_artifact(source, jpeg, source_filename, family_filenames, *, timestamp):
    """Attach standard metadata without changing any coded image/table/ICC bytes."""
    width, height = inspect_export_jpeg(jpeg)
    exif, xmp = _metadata_bytes(source, width, height, timestamp)
    def app1(payload):
        return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    output = bytearray(b"\xff\xd8" + app1(exif) + app1(XMP_HEADER + xmp))
    for marker, payload, encoded in _segments(jpeg):
        if marker == 0xE1 and (payload.startswith(b"Exif\0\0") or payload.startswith(XMP_HEADER)):
            continue
        output.extend(encoded)
    result = bytes(output)
    inspect_export_jpeg(result)
    return ExportArtifact(next_export_filename(source_filename, family_filenames), result)


@dataclass(frozen=True)
class RawExportInput:
    source: bytes
    source_filename: str
    family_filenames: tuple[str, ...]
    settings: dict
    timestamp: datetime


async def export_raw_artifact(request: RawExportInput, *, manager=None, temp_root=None):
    """P2 boundary: caller owns saved snapshot selection; this call owns isolated Native state."""
    if not isinstance(request.settings, dict):
        raise RawExportError("raw_export_invalid_settings")
    # Freeze before the first await; callers may continue editing their own settings object.
    try:
        encoded_settings = json.dumps(request.settings, allow_nan=False)
        if len(encoded_settings.encode("utf-8")) > 256 * 1024:
            raise ValueError
        settings = json.loads(encoded_settings)
    except (TypeError, ValueError, RecursionError) as error:
        raise RawExportError("raw_export_invalid_settings") from error
    source = bytes(request.source)
    family_filenames = tuple(request.family_filenames)
    extract_raw_metadata(source)
    owned = (manager or LightCraftManager()).diagnostic_manager(
        manager._gpu_backend if manager is not None else "dx12")
    lightcraft_log("export.started", sourceBytes=len(source))
    try:
        with tempfile.TemporaryDirectory(prefix="genzoroom-raw-export-", dir=temp_root) as directory:
            original = Path(directory) / "source.dng"
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
                imported = await tool("import", {"paths": [str(original)], "mode": "add"})
                ids = imported.get("imported")
                if not isinstance(ids, list) or len(ids) != 1 or type(ids[0]) is not int:
                    raise RawExportError("raw_export_invalid_import")
                photo = ids[0]
                await tool("select_photos", {"ids": [photo], "active": photo})
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
                if inspect_export_jpeg(jpeg) != (result.get("width"), result.get("height")):
                    raise RawExportError("raw_export_invalid_output")
                if await tool("get_develop", {"id": photo}) != settings:
                    raise RawExportError("raw_export_settings_mismatch")
                artifact = create_raw_export_artifact(source, jpeg, request.source_filename,
                    family_filenames, timestamp=request.timestamp)
                lightcraft_log("export.completed", artifactBytes=len(artifact.jpeg))
                return artifact
            finally:
                # Reap Native before deleting its source/output files, including cancellation.
                await owned.close()
    except BaseException:
        lightcraft_log("export.failed", level="error", errorCode="raw_export_failed")
        raise
