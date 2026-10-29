from datetime import datetime, timezone
from io import BytesIO
import struct
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageCms, ExifTags, TiffImagePlugin
import pytest

from raw_export_artifact import (RawExportError, create_raw_export_artifact,
                                 extract_raw_metadata, inspect_export_jpeg, _segments)


def source():
    exif = Image.Exif()
    exif.update({271: 'Camera maker', 272: 'Camera model', 315: 'Photographer', 274: 6,
                 37500: b'private', 33432: 'Copyright'})
    exif[ExifTags.IFD.Exif] = {36867: '2020:01:02 03:04:05', 36881: '+09:00',
        37521: '123456', 42035: 'Lens maker', 42036: 'Lens', 33434: TiffImagePlugin.IFDRational(1, 100),
        33437: TiffImagePlugin.IFDRational(28, 10), 34855: 100, 37380: TiffImagePlugin.IFDRational(-1, 2), 37386: 50, 41989: 75,
        42034: tuple(TiffImagePlugin.IFDRational(v) for v in (24, 70, 2.8, 2.8))}
    exif[ExifTags.IFD.GPSInfo] = {1: 'N', 2: (35, 1, 2), 3: 'E', 4: (139, 2, 3),
        5: 0, 6: 123, 7: (3, 4, 5), 16: 'T', 17: 90, 29: '2020:01:02'}
    return exif.tobytes()[6:]


def jpeg():
    out = BytesIO()
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    Image.new('RGB', (32, 24), (80, 100, 120)).save(out, 'JPEG', quality=95, subsampling=0, icc_profile=icc)
    return out.getvalue()


def test_metadata_and_coded_image_preserved():
    raw, original = source(), jpeg()
    instant = datetime(2026, 1, 2, tzinfo=timezone.utc)
    artifact = create_raw_export_artifact(raw, original, 'test.dng', ['test-Genzo03.jpg'], timestamp=instant)
    assert artifact.filename == 'test-Genzo04.jpg'
    assert inspect_export_jpeg(artifact.jpeg) == (32, 24)
    def coded(value):
        return [encoded for marker, payload, encoded in _segments(value) if marker != 0xE1]
    assert coded(original) == coded(artifact.jpeg)
    second = create_raw_export_artifact(raw, artifact.jpeg, 'test.dng', (), timestamp=instant)
    assert second.jpeg == artifact.jpeg
    with Image.open(BytesIO(artifact.jpeg)) as image:
        image.load()
        exif = image.getexif()
        capture = exif.get_ifd(ExifTags.IFD.Exif)
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
        assert exif[305] == 'GenzoRoom' and exif[274] == 1
        assert exif[271] == 'Camera maker' and 37500 not in exif
        assert capture[36881] == '+09:00' and capture[37521] == '123456'
        assert (capture[40962], capture[40963], capture[40961]) == (32, 24, 1)
        assert capture[37380] == -.5 and capture[41989] == 75
        assert gps[6] == 123 and gps[17] == 90
        assert b'GenzoRoom' in image.info['xmp']
        with Image.open(BytesIO(original)) as before:
            assert image.info['icc_profile'] == before.info['icc_profile']


@pytest.mark.parametrize('value', [b'', b'not raw', b'II*\0' + b'\xff' * 12])
def test_invalid_raw(value):
    with pytest.raises(RawExportError):
        extract_raw_metadata(value)


@pytest.mark.parametrize('change', [lambda b: b[:-2], lambda b: b + b'junk',
    lambda b: b.replace(b'ICC_PROFILE', b'BAD_PROFILE'), lambda b: b'bad'])
def test_invalid_jpeg(change):
    with pytest.raises(RawExportError):
        inspect_export_jpeg(change(jpeg()))


def test_invalid_timestamp():
    with pytest.raises(RawExportError, match='invalid_export_timestamp'):
        create_raw_export_artifact(source(), jpeg(), 'test.dng', (), timestamp=datetime(2026, 1, 1))


def test_cyclic_ifd_rejected():
    raw = bytearray(source())
    order = '<' if raw[:2] == b'II' else '>'
    offset = struct.unpack_from(order + 'I', raw, 4)[0]
    count = struct.unpack_from(order + 'H', raw, offset)[0]
    for position in range(offset + 2, offset + 2 + count * 12, 12):
        if struct.unpack_from(order + 'H', raw, position)[0] == 34665:
            struct.pack_into(order + 'I', raw, position + 8, offset)
    with pytest.raises(RawExportError):
        extract_raw_metadata(bytes(raw))


@pytest.mark.parametrize('mode', ['success', 'mismatch', 'failure', 'cancel'])
def test_isolated_session_cleanup(tmp_path, mode):
    from raw_export_artifact import RawExportInput, export_raw_artifact
    settings = {'process': 5, 'test': 'saved'}
    events = []
    class Owned:
        async def start(self):
            events.append('start')
        def status(self):
            return SimpleNamespace(state='ready')
        def artifact_info(self):
            return {'verified': True}
        def _ready_client(self):
            return self
        async def close(self):
            events.append('close')
        async def call_tool_result(self, name, args, **kwargs):
            value = {}
            if name == 'import':
                assert Path(args['paths'][0]).is_file()
                value = {'imported': [1]}
            if name == 'get_develop':
                value = {} if mode == 'mismatch' else settings
            if name == 'export':
                assert args['quality'] == 95 and args['longEdge'] == 0 and args['metadata'] == 'none'
                Path(args['path']).write_bytes(jpeg())
                if mode == 'failure':
                    raise RuntimeError('native failed')
                if mode == 'cancel':
                    raise asyncio.CancelledError()
                value = {'width': 32, 'height': 24}
            return {'structuredContent': value}
    class Manager:
        _gpu_backend = 'dx12'
        def diagnostic_manager(self, backend):
            assert backend == 'dx12'
            return Owned()
    request = RawExportInput(source(), 'source.dng', (), settings, datetime.now(timezone.utc))
    async def run():
        return await export_raw_artifact(request, manager=Manager(), temp_root=tmp_path)
    if mode == 'success':
        assert asyncio.run(run()).filename == 'source-Genzo01.jpg'
    else:
        expected = asyncio.CancelledError if mode == 'cancel' else RawExportError if mode == 'mismatch' else RuntimeError
        with pytest.raises(expected):
            asyncio.run(run())
    assert events == ['start', 'close']
    assert not list(tmp_path.iterdir())
    assert settings == {'process': 5, 'test': 'saved'}


def test_xmp_unicode_and_private_namespace():
    exif = Image.Exif()
    exif[700] = b'''<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:p="urn:private"><rdf:RDF><rdf:Description><dc:title>title</dc:title><p:secret>hidden</p:secret></rdf:Description></rdf:RDF></x:xmpmeta>'''
    exif[700] = exif[700].replace(b'>title<', '>題名<'.encode('utf-8'))
    raw = exif.tobytes()[6:]
    result = create_raw_export_artifact(raw, jpeg(), 'a.dng', (), timestamp=datetime.now(timezone.utc))
    with Image.open(BytesIO(result.jpeg)) as image:
        assert '題名'.encode('utf-8') in image.info['xmp'] and b'hidden' not in image.info['xmp']
