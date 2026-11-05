"""Probe the read-only lens profile information command on the actual managed binary."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment


async def _probe(binary, expected_version):
    with tempfile.TemporaryDirectory(prefix='genzoroom-lens-info-') as folder:
        source = Path(folder) / 'metadata-free.png'
        Image.new('RGB', (32, 24), (80, 100, 120)).save(source)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend='off', temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('lens-profile-info-probe', expected_version=expected_version, timeout=30)
            imported = await client.call_tool('command_run', {
                'id': 'library.import', 'params': {'paths': [str(source)], 'mode': 'add'}}, timeout=60)
            photo_id = imported['imported'][0]
            result = await client.call_tool('command_run', {
                'id': 'photo.lensProfileInfo', 'params': {'id': photo_id}}, timeout=60)
            expected = {
                'cameraMake': None, 'cameraModel': None, 'lensMake': None, 'lensModel': None, 'lensId': None,
                'profileAvailable': None, 'profileSource': 'unknown', 'profileName': None,
                'profileHasDistortion': False, 'profileHasVignetting': False,
            }
            if result != expected:
                raise ValueError('lens profile info unknown-state response mismatch')
            print('Lens profile info binary probe ' + json.dumps({'contract': 1, 'source': 'unknown', 'checks': 1}, separators=(',', ':')))
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def probe_lens_profile_info(binary, *, expected_version):
    asyncio.run(_probe(binary, expected_version))
