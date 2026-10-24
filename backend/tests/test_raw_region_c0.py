import asyncio

from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_adaptive_preview import target


def test_c0_keeps_b1_whole_and_never_sends_a_region_to_the_existing_binary(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        try:
            async with client(local) as http:
                await authenticate(http, local)
                capability = (await http.get('/api/raw/capabilities')).json()
                assert capability['available'] is True
                assert 'regionContract' not in capability
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/preview'
                before = len(child.preview_arguments)
                rejected = await http.post(url, json=target(doc) | {'mode': 'region'})
                assert rejected.status_code == 400
                assert len(child.preview_arguments) == before
                whole = await http.post(url, json=target(doc, serial=2, quality='full'))
                assert whole.status_code == 200
                assert child.preview_arguments[-1]['quality'] == 'full'
                assert 'region_contract' not in child.preview_arguments[-1]
                assert api.document['revision'] == doc['revision']
        finally:
            await api.close()
    asyncio.run(run())
