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


def jpeg(*, progressive=False):
    out = BytesIO()
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    Image.new('RGB', (32, 24), (80, 100, 120)).save(out, 'JPEG', quality=95, subsampling=0, icc_profile=icc, progressive=progressive)
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


@pytest.mark.parametrize('mode', ['success', 'mismatch', 'failure', 'cancel', 'non_tiff', 'unreadable', 'source_match', 'source_mismatch'])
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
            if name == 'command_run' and args['id'] == 'photo.inspect':
                value = {'content_hash': 'different' if mode == 'source_mismatch' else 'expected'}
            if name == 'import':
                assert Path(args['paths'][0]).is_file()
                assert Path(args['paths'][0]).name == ('sample.CR3' if mode == 'non_tiff' else 'source.dng')
                assert Path(args['paths'][0]).parent.parent.parent == tmp_path
                if mode == 'unreadable':
                    from lightcraft_mcp import MCPToolError
                    raise MCPToolError()
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
    raw = b'unsupported metadata container' if mode == 'non_tiff' else source()
    filename = 'sample.CR3' if mode == 'non_tiff' else 'source.dng'
    request = RawExportInput(raw, filename, (), settings, datetime.now(timezone.utc),
        expected_content_hash='expected' if mode in ('source_match','source_mismatch') else None)
    async def run():
        return await export_raw_artifact(request, manager=Manager(), temp_root=tmp_path)
    if mode in ('success', 'non_tiff', 'source_match'):
        result = asyncio.run(run())
        assert result.filename == ('sample-Genzo01.jpg' if mode == 'non_tiff' else 'source-Genzo01.jpg')
        with Image.open(BytesIO(result.jpeg)) as image:
            assert image.getexif()[305] == 'GenzoRoom'
            assert image.getexif()[274] == 1
    else:
        expected = asyncio.CancelledError if mode == 'cancel' else RawExportError if mode in ('mismatch', 'unreadable', 'source_mismatch') else RuntimeError
        with pytest.raises(expected):
            asyncio.run(run())
    assert events == ['start', 'close']
    assert not list(tmp_path.iterdir())
    assert settings == {'process': 5, 'test': 'saved'}
    assert request.source == raw


@pytest.mark.parametrize('filename', ['photo.ARW', 'photo.PEF', 'photo.NEF', 'photo.CR2', 'photo.CR3', 'photo.unknown'])
def test_input_extension_preserved(filename):
    from raw_export_artifact import _input_filename
    assert _input_filename(filename) == filename


@pytest.mark.parametrize('filename', ['../../photo.CR3', r'C:\outside\photo.ARW', 'CON.PEF', 'a:b.NEF'])
def test_input_filename_is_single_safe_component(filename):
    from raw_export_artifact import _input_filename
    name = _input_filename(filename)
    assert '/' not in name and '\\' not in name and ':' not in name
    assert name not in ('.', '..') and name != 'CON.PEF'


@pytest.mark.parametrize('raw', [b'non-TIFF container', b'II*\0' + b'\xff' * 12])
def test_optional_metadata_does_not_block_artifact(raw):
    original = jpeg()
    result = create_raw_export_artifact(raw, original, 'photo.CR3', (), timestamp=datetime.now(timezone.utc))
    assert [v for m,p,v in _segments(original) if m != 0xe1] == [v for m,p,v in _segments(result.jpeg) if m != 0xe1]
    with Image.open(BytesIO(result.jpeg)) as image:
        assert image.getexif()[305] == 'GenzoRoom'
        assert image.getexif().get_ifd(ExifTags.IFD.Exif)[40961] == 1


def test_xmp_unicode_and_private_namespace():
    exif = Image.Exif()
    exif[700] = b'''<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:p="urn:private"><rdf:RDF><rdf:Description><dc:title>title</dc:title><p:secret>hidden</p:secret></rdf:Description></rdf:RDF></x:xmpmeta>'''
    exif[700] = exif[700].replace(b'>title<', '>題名<'.encode('utf-8'))
    raw = exif.tobytes()[6:]
    result = create_raw_export_artifact(raw, jpeg(), 'a.dng', (), timestamp=datetime.now(timezone.utc))
    with Image.open(BytesIO(result.jpeg)) as image:
        assert '題名'.encode('utf-8') in image.info['xmp'] and b'hidden' not in image.info['xmp']

@pytest.mark.parametrize('progressive', [False, True])
def test_scan_layout_and_duplicate_app1(progressive, monkeypatch):
    import raw_export_artifact as module
    original = jpeg(progressive=progressive)
    first = create_raw_export_artifact(source(), original, 'a.dng', (), timestamp=datetime.now(timezone.utc)).jpeg
    app = next(v for m,p,v in _segments(first) if m == 0xe1)
    duplicated = first[:2] + app + first[2:]
    parse = module._parse_jpeg
    calls = []
    def counted(value):
        calls.append(len(value)); return parse(value)
    monkeypatch.setattr(module, '_parse_jpeg', counted)
    monkeypatch.setattr(Image.Image, 'save', lambda *a, **k: pytest.fail('re-encode'))
    monkeypatch.setattr(Image.Image, 'load', lambda *a, **k: pytest.fail('pixel decode'))
    result = create_raw_export_artifact(source(), duplicated, 'a.dng', (), timestamp=datetime.now(timezone.utc)).jpeg
    assert len(calls) == 1
    def coded(b):
        return b''.join(b[a:z] for m,p,a,z in parse(b).segments if m != 0xe1)
    assert coded(original) == coded(result)
    layout = parse(result)
    assert sum(m == 0xe1 for m,p,a,z in layout.segments) == 2
    if progressive:
        assert sum(m == 0xda for m,p,a,z in layout.segments) > 1


@pytest.mark.parametrize('damage', ['length', 'scan', 'eoi'])
def test_marker_boundary_rejection(damage):
    value = jpeg(progressive=True)
    if damage == 'length': value = value[:4] + b'\xff\xff' + value[6:]
    elif damage == 'scan': value = value[:value.index(b'\xff\xda') + 7]
    else: value = value[:-2]
    with pytest.raises(RawExportError):
        create_raw_export_artifact(source(), value, 'a.dng', (), timestamp=datetime.now(timezone.utc))


def test_large_header_no_pixel_decode(monkeypatch):
    value = bytearray(jpeg()); at = value.index(b'\xff\xc0')
    value[at + 5:at + 9] = struct.pack('>HH', 20000, 20000)
    monkeypatch.setattr(Image, 'open', lambda *a, **k: pytest.fail('image decode'))
    assert inspect_export_jpeg(bytes(value)) == (20000, 20000)


def test_icc_description_not_contract(monkeypatch):
    value = jpeg()
    monkeypatch.setattr(ImageCms, 'getProfileDescription', lambda *a: pytest.fail('description check'))
    assert inspect_export_jpeg(value) == (32, 24)


@pytest.mark.parametrize('exif_over,xmp_over', [(True,False),(False,True),(True,True)])
def test_metadata_aggregate_fallback(exif_over, xmp_over, monkeypatch):
    import raw_export_artifact as module
    root = {k: 'a' * 16000 for k in (271,272,315,33432,270)} if exif_over else {271:'maker'}
    xmp = {f'{{{module.metadata.DC}}}subject': [(None, 'x' * 16000)] * 5} if xmp_over else {}
    monkeypatch.setattr(module, '_optional_source_metadata', lambda _: (root.copy(), {}, {}, xmp))
    events = []
    monkeypatch.setattr(module, 'lightcraft_log', lambda event, **kwargs: events.append(event))
    original = jpeg()
    result = create_raw_export_artifact(source(), original, 'a.dng', (), timestamp=datetime.now(timezone.utc)).jpeg
    assert events == ['export.metadata_reduced']
    with Image.open(BytesIO(result)) as image:
        e = image.getexif();c = e.get_ifd(ExifTags.IFD.Exif)
        assert e[305] == 'GenzoRoom' and e[274] == 1 and 271 not in e
        assert (c[40962], c[40963], c[40961]) == (32,24,1)
        assert b'GenzoRoom' in image.info['xmp']
    assert [v for m,p,v in _segments(original) if m != 0xe1] == [v for m,p,v in _segments(result) if m != 0xe1]


@pytest.mark.parametrize('invalid', [float('nan'), float('inf'), {1,2}, object()])
def test_non_json_settings_rejected(invalid):
    from raw_export_artifact import RawExportInput, export_raw_artifact
    request = RawExportInput(source(), 'a.dng', (), {'bad':invalid}, datetime.now(timezone.utc))
    with pytest.raises(RawExportError, match='raw_export_invalid_settings'):
        asyncio.run(export_raw_artifact(request))

@pytest.mark.parametrize('over', [False, True])
def test_recipe_store_export_size_contract(tmp_path, over):
    import raw_export_artifact as module
    from edit_store import _json
    from raw_recipe_store import _settings_json, InvalidRawRecipe, MAX_SETTINGS_BYTES
    settings = {'version':1,'process':5,'wb':{'mode':'custom','temp':6000,'tint':0},'label':'題' * 40000}
    remaining = MAX_SETTINGS_BYTES - len(_json(settings).encode('utf-8'))
    settings['label'] += 'x' * (remaining + int(over))
    assert len(json.dumps(settings).encode('utf-8')) > MAX_SETTINGS_BYTES
    if over:
        with pytest.raises(InvalidRawRecipe): _settings_json(settings, 1)
    else:
        assert len(_settings_json(settings, 1).encode('utf-8')) == MAX_SETTINGS_BYTES
    class Disabled:
        async def start(self): pass
        def status(self): return SimpleNamespace(state='disabled')
        async def close(self): pass
    class Manager:
        _gpu_backend='dx12'
        def diagnostic_manager(self, backend): return Disabled()
    request = module.RawExportInput(source(),'a.dng',(),settings,datetime.now(timezone.utc))
    code = 'raw_export_invalid_settings' if over else 'raw_export_engine_unavailable'
    with pytest.raises(RawExportError, match=code):
        asyncio.run(module.export_raw_artifact(request, manager=Manager(), temp_root=tmp_path))
    assert not list(tmp_path.iterdir())


def test_app1_between_progressive_scans():
    original = jpeg(progressive=True)
    scans = [a for m,p,a,z in __import__('raw_export_artifact')._parse_jpeg(original).segments if m == 0xda]
    app = b'\xff\xe1\x00\x08Exif\x00\x00'
    value = original[:scans[1]] + app + original[scans[1]:]
    result = create_raw_export_artifact(source(), value, 'a.dng', (), timestamp=datetime.now(timezone.utc)).jpeg
    assert sum(m == 0xe1 for m,p,v in _segments(result)) == 2
    assert [v for m,p,v in _segments(original) if m!=0xe1] == [v for m,p,v in _segments(result) if m!=0xe1]


def test_renamed_rgb_icc_preserved():
    original = jpeg().replace(b'\x00s\x00R\x00G\x00B', b'\x00T\x00e\x00s\x00t')
    with Image.open(BytesIO(original)) as image:
        profile = ImageCms.ImageCmsProfile(BytesIO(image.info['icc_profile']))
        assert 'srgb' not in ImageCms.getProfileDescription(profile).lower()
        icc = image.info['icc_profile']
    result = create_raw_export_artifact(source(), original, 'a.dng', (), timestamp=datetime.now(timezone.utc)).jpeg
    with Image.open(BytesIO(result)) as image:
        assert image.info['icc_profile'] == icc
