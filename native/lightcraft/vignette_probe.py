"""Managed Native vignette diagnostic; synthetic RGB is not a real-RAW acceptance test."""
import argparse
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time

from PIL import Image, ImageDraw
from effects_probe import (BASE, MANAGED, LightCraftMCP, child_environment, differences,
    procedural_scene, resolve_managed_executable, validate_result, verified_artifact, write_report)

DEFAULT = dict(amount=0, midpoint=50, feather=50, roundness=0, highlights=0)
STYLES = ('highlightPriority', 'colorPriority', 'paintOverlay')


async def probe(binary, backend, output):
    with tempfile.TemporaryDirectory(prefix='genzoroom-vignette-') as folder:
        source = Path(folder) / 'scene.png'
        procedural_scene(source)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('vignette-probe', expected_version=MANAGED['version'], timeout=30)
            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)
            gpu = await command('app.gpu', {})
            if backend == 'dx12' and not gpu['available']:
                return {'backend': backend, 'skipped': 'no_adapter'}, {}
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            await command('develop.set', {'values': BASE})
            async def settings():
                return await client.call_tool('get_develop', {'id': photo})
            async def merge(value):
                before = await settings()
                await command('develop.merge', {'settings': {'vignette': value}})
                expected = copy.deepcopy(before)
                expected['vignette'].update(value)
                assert await settings() == expected
            timings, checks, samples, executions = [], [], {}, []
            def execution(meta):
                actual = meta['execution']['outcome']
                assert actual in ('gpu_success', 'cpu_not_tried', 'cpu_fallback'), actual
                if meta['execution'] not in executions: executions.append(meta['execution'])
            def unpack(result):
                meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                image = Image.open(io.BytesIO(base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image')))).convert('RGB')
                return image, meta
            async def whole(side=1024, quality='full', cache='off', label=''):
                start = time.perf_counter()
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': quality, 'preview_contract': 1, 'stage_cache': cache,
                    **({'stage_cache_budget_bytes': 512 * 1024**2} if cache == 'on' else {})}, timeout=90)
                image, meta = unpack(result)
                execution(meta)
                timings.append(dict(case=label, mode='whole', side=side, quality=quality, cache=cache,
                                    execution=meta['execution'],
                                    requestMs=round((time.perf_counter()-start)*1000, 3)))
                return image, meta
            cases = [('neutral', {}), ('negative', dict(amount=-100)), ('positive', dict(amount=100)),
                ('midpoint', dict(amount=-100, midpoint=0)), ('feather', dict(amount=-100, feather=0)),
                ('roundness', dict(amount=-100, roundness=-100)), ('roundnessPositive', dict(amount=-100, roundness=100)),
                ('zeroDependents', dict(midpoint=0, feather=100, roundness=-100, highlights=100))]
            cases += [(style, dict(amount=-100, midpoint=0, highlights=100, style=style)) for style in STYLES]
            for index, (name, values) in enumerate(cases):
                print(f'vignette {backend}: {name}', flush=True)
                await merge(DEFAULT | {'style': STYLES[0]} | values)
                for side in ((1024, 2048) if name in ('negative', 'positive', 'highlightPriority') else (1024,)):
                    for quality in ('draft', 'full'):
                        reference, meta = await whole(side, quality, label=name)
                        if side == 1024 and quality == 'full': samples[name] = reference
                        identity = dict(assetId='12345678-1234-4234-9234-123456789abc', sourceId=hashlib.sha256(source.read_bytes()).hexdigest(),
                            generation=1, documentToken='c'*32, kind='after', revision=index+1)
                        query = dict(contractVersion=1, mode='region', quality=quality, geometryId=meta['frame']['geometryId'],
                            identity=identity, documentRevision=index+1, viewGeneration=index+1, requestId='d'*32)
                        plan = await client.call_tool_result('render_region_preview', dict(id=str(photo), region_contract=1, operation='plan',
                            target=query | {'desiredLongEdge': side}, stage_cache='off'), timeout=90)
                        _, planned = validate_result(plan, query | {'desiredLongEdge': side}, 'plan', photo)
                        fw, fh = planned['response']['fullWidth'], planned['response']['fullHeight']
                        assert reference.size == (fw, fh)
                        for location, x, y in [('center', fw//2-192, fh//2-144), ('topLeft',0,0), ('topRight',fw-384,0),
                            ('bottomLeft',0,fh-288), ('bottomRight',fw-384,fh-288), ('edge',0,fh//2-144), ('pan',fw//2-179,fh//2-137)]:
                            wx, wy = max(0,x-16), max(0,y-16)
                            right, bottom = min(fw,x+400), min(fh,y+304)
                            target = query | dict(fullWidth=fw, fullHeight=fh, context=16, prefetch=0,
                                window=dict(x=wx,y=wy,w=right-wx,h=bottom-wy), validRegion=dict(x=x,y=y,w=384,h=288))
                            start = time.perf_counter()
                            result = await client.call_tool_result('render_region_preview', dict(id=str(photo), region_contract=1,
                                operation='render', target=target, stage_cache='off'), timeout=90)
                            png, metadata = validate_result(result,target,'render',photo)
                            execution(metadata['diagnostics'])
                            rendered = Image.open(io.BytesIO(png)).convert('RGB')
                            checks.append(dict(case=name, side=side, quality=quality, location=location,
                                execution=metadata['diagnostics']['execution'],
                                window=target['window'], validRegion=target['validRegion'],
                                difference=differences(reference.crop((x,y,x+384,y+288)),rendered.crop((x-wx,y-wy,x-wx+384,y-wy+288))),
                                requestMs=round((time.perf_counter()-start)*1000,3)))
            assert samples['neutral'].tobytes() == samples['zeroDependents'].tobytes()
            effects = {name: differences(samples['neutral' if name in ('negative','positive') else 'negative'],samples[name])
                for name in ('negative','positive','midpoint','feather','roundness','roundnessPositive')}
            assert all(v['maxLsb'] > 0 for v in effects.values())
            modes = {style: differences(samples['highlightPriority'],samples[style]) for style in STYLES[1:]}
            assert all(v['maxLsb'] > 0 for v in modes.values())
            for style in STYLES:
                await merge(DEFAULT | dict(amount=100, style=style))
                image, _ = await whole(label='positiveMode:'+style)
                assert image.tobytes() == samples['positive'].tobytes()
            await merge(DEFAULT | dict(amount=-73, midpoint=23, feather=87, roundness=-34, highlights=89, style='paintOverlay'))
            before = await settings()
            on, _ = await whole()
            await command('develop.sectionEnabled',dict(section='effects',enabled=False))
            off, _ = await whole()
            assert differences(on,off)['maxLsb'] > 0
            assert await settings() == before | {'disabled_sections':['effects']}
            await command('develop.resetSection',dict(section='effects'))
            assert await settings() == before | {'disabled_sections':['effects']}
            await command('develop.resetSection',dict(section='vignette'))
            expected = copy.deepcopy(before)
            expected['vignette'].update(DEFAULT)
            expected['disabled_sections'] = ['effects']
            assert await settings() == expected
            await command('develop.sectionEnabled',dict(section='effects',enabled=True))
            await merge(before['vignette'])
            restored,_ = await whole()
            assert on.tobytes() == restored.tobytes()
            for field, value in DEFAULT.items():
                before = await settings()
                await command('develop.set',dict(values={'vignette.'+field:73}))
                before['vignette'][field] = 73
                assert await settings() == before
                await command('develop.resetControl',dict(control='vignette.'+field))
                before['vignette'][field] = value
                assert await settings() == before
            await merge(dict(amount=-100))
            cold,_ = await whole(cache='on',label='stageCold')
            warm,_ = await whole(cache='on',label='stageWarm')
            assert cold.tobytes() == warm.tobytes()
            if backend == 'off':
                sheet = Image.new('RGB',(1024,3*408),'#202020')
                draw = ImageDraw.Draw(sheet)
                for index,name in enumerate(('neutral','negative','positive','highlightPriority','colorPriority','paintOverlay')):
                    x,y=(index%2)*512,(index//2)*408
                    sheet.paste(samples[name].resize((512,384)),(x,y+24)); draw.text((x+8,y+5),name,fill='white')
                sheet.save(output.with_suffix('.png'))
            return dict(backend=backend,
                actualExecutions=executions,readbackResetToggle='pass',zeroAmountInvariant=True,coldWarmIdentical=True,
                parameterEffects=effects,modeEffects=modes,checks=checks,timings=timings),samples
        finally:
            await client.close()
            if process.returncode is None: process.terminate()
            await asyncio.wait_for(process.wait(),10)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json-out',type=Path,required=True)
    args=parser.parse_args()
    binary=Path(resolve_managed_executable({},'win32'))
    digest=hashlib.sha256(binary.read_bytes()).hexdigest()
    assert verified_artifact(binary,digest,MANAGED['version']) is not None
    args.json_out.parent.mkdir(parents=True,exist_ok=True)
    results,samples=[],[]
    for backend in ('off','dx12'):
        result,images=asyncio.run(probe(binary,backend,args.json_out))
        results.append(result); samples.append(images)
    report=dict(version=MANAGED['version'],commit=MANAGED['commit'],binarySha256=digest,
        source='procedural RGB 2048x1536; 2048 is 100% grid; not camera RAW',context=16,
        limitations=['noRealRaw','noBrowser','noRssVram','requestTimesIncludeTransportDecode','stageColdNotSourceCold'],
        results=results,cpuDx12={name:differences(samples[0][name],samples[1][name]) for name in samples[0].keys() & samples[1].keys()})
    write_report(args.json_out, report)
    print(json.dumps(dict(checks=sum(len(r.get('checks',[])) for r in results),output=str(args.json_out))))


if __name__=='__main__': main()
