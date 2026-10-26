from pathlib import Path
import json
import os

repository = Path(SPECPATH).parents[1]
frontend = repository / 'frontend' / 'dist'
manifest = Path(os.environ['GENZOROOM_PACKAGE_MANIFEST'])
if not (frontend / 'index.html').is_file() or not manifest.is_file():
    raise RuntimeError('package_inputs_missing')

a = Analysis(
    [str(repository / 'backend' / 'windows_local.py')],
    pathex=[str(repository / 'backend')],
    binaries=[],
    datas=[(str(frontend), 'frontend/dist'), (str(manifest), '.'),
           (str(repository / 'backend' / 'raw_region_schema.json'), '.'),
           (str(repository / 'native' / 'lightcraft' / 'manifest.json'), 'native/lightcraft')],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=['pytest', 'pip', 'setuptools', 'tkinter', 'IPython'],
    noarchive=False,
)
pyz = PYZ(a.pure)
# Console bootloader preserves the private pipes; Rust hides its console window.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True,
          name='genzoroom-backend', debug=False, strip=False, upx=False, console=True)
bundle = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='genzoroom-backend')
collection = [{'name': name, 'kind': kind} for name, _source, kind in [*a.pure, *a.binaries, *a.datas]]
Path(DISTPATH, 'genzoroom-backend', 'collection.json').write_text(
    json.dumps(collection, indent=2), encoding='utf-8')
