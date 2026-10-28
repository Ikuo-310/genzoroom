"""Phase 6A-R causal experiments, only against explicitly instrumented isolated Native builds."""
import argparse
import asyncio
import base64
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time

from effects_probe import (ROOT, BASE, procedural_scene, differences, write_report, Image,
    LightCraftMCP, child_environment, validate_result, MANAGED, resolve_managed_executable, verified_artifact)


def memory(pid):
    if os.name != 'nt':
        return None
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('faults', wintypes.DWORD)] + [(key, ctypes.c_size_t) for key in
            ('peakWorkingSetBytes', 'workingSetBytes', 'peakPagedPool', 'pagedPool', 'peakNonpagedPool',
             'nonpagedPool', 'pagefile', 'peakPagefile', 'privateBytes')]
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    get = ctypes.windll.psapi.GetProcessMemoryInfo
    get.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    handle = kernel.OpenProcess(0x1010, False, pid)
    if not handle:
        return None
    try:
        values = Counters()
        values.cb = ctypes.sizeof(values)
        if not get(handle, ctypes.byref(values), values.cb):
            return None
        return {key: getattr(values, key) for key in ('workingSetBytes', 'peakWorkingSetBytes', 'privateBytes')}
    finally:
        kernel.CloseHandle(handle)


def decode_float(bits):
    return struct.unpack('!f', struct.pack('!I', bits))[0]


class Session:
    def __init__(self, binary, backend, folder, diagnostic=True):
        self.binary, self.backend, self.folder, self.diagnostic = binary, backend, Path(folder), diagnostic
        self.control = self.folder / 'control.txt'
        self.trace = self.folder / 'air.csv'
        self.process = None
        self.serial = 0
        self.timings = []

    async def __aenter__(self):
        env = child_environment(os.environ, gpu_backend=self.backend, temp_directory=str(self.folder))
        if self.diagnostic:
            env |= {'GENZOROOM_REGION_CAUSE_CONTROL': str(self.control), 'GENZOROOM_REGION_CAUSE_TRACE': str(self.trace)}
        self.process = await asyncio.create_subprocess_exec(str(self.binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=env, **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        self.client = LightCraftMCP(self.process.stdout, self.process.stdin, 1)
        try:
            await self.client.initialize('region-root-cause', expected_version=MANAGED['version'], timeout=60)
            if self.backend == 'dx12' and not (await self.command('app.gpu', {}))['available']:
                raise RuntimeError('DX12 unavailable; do not silently substitute CPU')
        except BaseException:
            # __aexit__ is not called by async-with when initialization fails.
            await self.__aexit__()
            raise
        return self

    async def __aexit__(self, *_):
        await self.client.close()
        if self.process.returncode is None:
            self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 10)

    async def command(self, name, params):
        return await self.client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)

    async def load(self, source):
        self.photo = (await self.command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
        await self.command('library.select', {'ids': [self.photo], 'active': self.photo, 'mode': 'replace'})
        self.source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    async def settings(self, values):
        await self.command('develop.set', {'values': BASE | values})
        self.snapshot = await self.client.call_tool('get_develop', {'id': self.photo})

    async def render(self, name, args, label, force=None, guided='native'):
        if self.diagnostic:
            self.control.write_text(f'guided={guided}\n' + ('' if force is None else f'air={force!r}\n'), encoding='utf-8')
            self.trace.write_text('', encoding='utf-8')
        started = time.perf_counter()
        result = await self.client.call_tool_result(name, args, timeout=120)
        if name == 'render_preview':
            meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
            png = base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image'))
            execution = meta['execution']['outcome']
        else:
            png, meta = validate_result(result, args['target'], 'render', self.photo)
            execution = meta['diagnostics']['execution']['outcome']
        assert execution == ('gpu_success' if self.backend == 'dx12' else 'cpu_not_tried'), execution
        image = Image.open(io.BytesIO(png)).convert('RGB')
        ms = (time.perf_counter() - started) * 1000
        trace = None
        if self.diagnostic:
            rows = self.trace.read_text().strip().splitlines()
            assert len(rows) == 1, rows
            values = rows[0].split(',')
            assert values[0] == ('dx12' if self.backend == 'dx12' else 'cpu')
            trace = {'w': int(values[1]), 'h': int(values[2])}
            for key, raw in zip(('plane', 'proxy', 'current', 'used'), values[3:]):
                bits = int(raw)
                trace[key] = None if key == 'proxy' and bits == 0 else decode_float(bits)
                trace[key + 'Bits'] = bits
            if force is not None:
                assert trace['used'] == force
        timing = {'label': label, 'mode': 'whole' if name == 'render_preview' else 'region',
            'cache': args['stage_cache'], 'requestMs': round(ms, 3), 'execution': execution,
            'pixels': image.width * image.height, 'pngBytes': len(png), 'memoryAfterRequest': memory(self.process.pid)}
        if name == 'render_preview':
            timing['stageCache'] = meta.get('stageCache')
        else:
            timing['stageCache'] = meta['diagnostics'].get('stageCache')
            timing['workWindow'] = meta['diagnostics'].get('workWindow')
            timing['sourceLevel'] = meta['diagnostics'].get('sourceLevel')
            timing['sourceHostBytes'] = meta['diagnostics'].get('sourceHostBytes')
        self.timings.append(timing)
        return image, meta, trace

    async def whole(self, side, quality, label, force=None, guided='native', cache='off'):
        return await self.render('render_preview', {'id': self.photo, 'max_side': side, 'quality': quality,
            'preview_contract': 1, 'stage_cache': cache,
            **({'stage_cache_budget_bytes': 512*1024**2} if cache == 'on' else {})}, label, force, guided)

    def target(self, meta, quality, window, context):
        self.serial += 1
        fw, fh = meta['frame']['fullWidth'], meta['frame']['fullHeight']
        x, y, w, h = window
        vx, vy = x + (context if x else 0), y + (context if y else 0)
        right, bottom = x+w-(context if x+w < fw else 0), y+h-(context if y+h < fh else 0)
        identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': self.source_hash,
            'generation': 1, 'documentToken': 'c'*32, 'kind': 'after', 'revision': self.serial}
        return {'contractVersion': 1, 'mode': 'region', 'quality': quality, 'geometryId': meta['frame']['geometryId'],
            'identity': identity, 'documentRevision': self.serial, 'viewGeneration': self.serial, 'requestId': 'd'*32,
            'fullWidth': fw, 'fullHeight': fh, 'window': dict(x=x,y=y,w=w,h=h),
            'validRegion': dict(x=vx,y=vy,w=right-vx,h=bottom-vy), 'context': context, 'prefetch': 0}

    async def region(self, target, label, force=None, guided='native', cache='off'):
        return await self.render('render_region_preview', {'id': str(self.photo), 'region_contract': 1,
            'operation': 'render', 'target': target, 'stage_cache': cache,
            **({'stage_cache_budget_bytes': 512*1024**2} if cache == 'on' else {})}, label, force, guided)


def window_for(roi, fw, fh, context):
    x, y, w, h = roi
    left, top = max(0,x-context), max(0,y-context)
    return left, top, min(fw,x+w+context)-left, min(fh,y+h+context)-top


def cut(image, roi, window=None):
    x, y, w, h = roi
    if window is not None:
        x, y = x-window[0], y-window[1]
    return image.crop((x,y,x+w,y+h))


def compare(whole, region, roi, window):
    a, b = cut(whole,roi), cut(region,roi,window)
    return {'difference': differences(a,b),
            'innerDifference': differences(a.crop((48,48,a.width-48,a.height-48)), b.crop((48,48,b.width-48,b.height-48)))}


async def experiments(binary, managed, backend, performance_only=False):
    with tempfile.TemporaryDirectory(prefix='genzoroom-region-cause-') as folder:
        path = Path(folder)
        source = path / 'scene.png'
        procedural_scene(source)
        checks, air_groups, guided_checks, parity = [], [], [], []
        async with Session(binary,backend,path) as s:
            await s.load(source)
            for side in (() if performance_only else (1024,2048)):
                for nr in (False,True):
                    for amount in (40,100):
                        for quality in (('full','draft') if amount == 100 else ('full',)):
                            label = f'dehaze{amount}-nr{int(nr)}-{side}-{quality}'
                            print(backend, label, file=sys.stderr, flush=True)
                            values = {'effects.dehaze': amount, 'detail.nrLuminance':100 if nr else 0,
                                      'detail.nrColor':100 if nr else 0}
                            await s.settings(values)
                            whole, meta, wt = await s.whole(side,quality,label+'-A')
                            fw, fh = whole.size
                            assert fw == side
                            locations = [('center',fw//2-192,fh//2-144),('pan',fw//2-179,fh//2-137),
                                ('edge',0,fh//2-144),('topLeft',0,0),('topRight',fw-384,0),
                                ('bottomLeft',0,fh-288),('bottomRight',fw-384,fh-288)]
                            if quality == 'draft':
                                locations = locations[:3]
                            roi = (*locations[0][1:],384,288)
                            win = window_for(roi,fw,fh,16)
                            _, _, seed = await s.region(s.target(meta,quality,win,16),label+'-proxy')
                            proxy = seed['proxy']
                            assert proxy is not None and wt['proxy'] is None
                            common, _, ct = await s.whole(side,quality,label+'-C',force=proxy)
                            air_groups.append({'case': label, 'wholeAir':wt,'regionProxyAir':proxy,
                                'proxyWholeAir':ct, 'wholeChangedByC':differences(whole,common)})
                            for location,x,y in locations:
                                roi = (x,y,384,288)
                                for context in ((16,64,128,256) if quality == 'full' else (16,256)):
                                    win = window_for(roi,fw,fh,context)
                                    target = s.target(meta,quality,win,context)
                                    for mode, forced, reference in [('A',None,whole),('B',wt['used'],whole),('C',proxy,common)]:
                                        image, _, trace = await s.region(target,label+'-'+mode,force=forced)
                                        assert trace['proxy'] == proxy
                                        checks.append({'case':label,'mode':mode,'side':side,'quality':quality,'nr':nr,
                                            'amount':amount,'location':location,'context':context,'roi':roi,'window':win,
                                            'air':trace,**compare(reference,image,roi,win)})
                                        if side==1024 and not nr and amount==100 and quality=='full' and context==16 and location=='center' and mode=='A':
                                            diagnostic_pair = (whole.copy(),image.copy())
                            assert await s.client.call_tool('get_develop',{'id':s.photo}) == s.snapshot
            # Direct diagnostic controls establish phase sensitivity independently of airlight.
            for side in (() if performance_only else (1024,2048)):
                await s.settings({'effects.clarity':100})
                roi = (side//2-192,side*3//8-144,384,288)
                # Both grids divide the native step exactly (4 / 8); 128px exceeds the clarity support.
                step = 4 if side==1024 else 8
                base_x, base_y = roi[0]-128,roi[1]-128
                for guided in ('native','exact'):
                    whole,meta,_ = await s.whole(side,'full',f'guided-{guided}-{side}',guided=guided)
                    aligned = None
                    for shift,width_add in ((0,0),(1,0),(step-1,0),(step,0),(0,1),(0,step)):
                        win = (base_x+shift,base_y,640+width_add,544)
                        target = s.target(meta,'full',win,64)
                        image,_,_ = await s.region(target,f'guided-{guided}-{side}',guided=guided)
                        roi_image = cut(image,roi,win)
                        if aligned is None:
                            aligned = roi_image
                        guided_checks.append({'side':side,'guided':guided,'step':step,'shiftX':shift,'widthAdd':width_add,
                            'window':win,'roi':roi,**compare(whole,image,roi,win),
                            'versusAlignedRegion':differences(aligned,roi_image)})
            for effect in (() if performance_only else ('texture','clarity','combinedNRSharpen')):
                values = {f'effects.{effect}':100} if effect!='combinedNRSharpen' else {
                    'effects.texture':70,'effects.clarity':70,'effects.dehaze':70,'detail.nrLuminance':100,
                    'detail.nrColor':100,'detail.sharpenAmount':150}
                for side in (1024,2048):
                    await s.settings(values)
                    whole,meta,wt=await s.whole(side,'full',effect)
                    fw,fh=whole.size
                    for location,x,y in [('center',fw//2-192,fh//2-144),('pan',fw//2-179,fh//2-137),('topLeft',0,0),('bottomRight',fw-384,fh-288)]:
                        roi=(x,y,384,288)
                        for context in (16,64,128,256):
                            win=window_for(roi,fw,fh,context)
                            image,_,trace=await s.region(s.target(meta,'full',win,context),effect,force=wt['used'])
                            checks.append({'case':effect,'mode':'B','side':side,'quality':'full','location':location,
                                'context':context,'roi':roi,'window':win,'air':trace,**compare(whole,image,roi,win)})
            # Repeat identical geometry with cache ON. Telemetry injection stays outside plane caches.
            await s.settings({'effects.clarity':70,'effects.dehaze':100,'detail.nrLuminance':100,'detail.nrColor':100})
            whole,meta,wt=await s.whole(1536,'full','prepare-performance')
            roi=(576,432,384,288)
            for mode in ('A',):
                win=window_for(roi,1536,1152,16)
                _,_,rt=await s.region(s.target(meta,'full',win,16),'prepare-performance')
                forced = None if mode=='A' else wt['used'] if mode=='B' else rt['proxy']
                await s.whole(1536,'full',f'perf-{mode}-whole-cold',force=forced,cache='on')
                await s.whole(1536,'full',f'perf-{mode}-whole-warm',force=forced,cache='on')
                for context in (16,64,128,256):
                    win=window_for(roi,1536,1152,context)
                    target=s.target(meta,'full',win,context)
                    await s.region(target,f'perf-{mode}-region-cold-{context}',force=forced,cache='on')
                    await s.region(target,f'perf-{mode}-region-warm-{context}',force=forced,cache='on')
            timings=s.timings
        if performance_only:
            return {'backend':backend,'requestTimings':timings}
        managed_folder=path/'managed'
        managed_folder.mkdir()
        async with Session(managed,backend,managed_folder,False) as original:
            await original.load(source)
            await original.settings({'effects.dehaze':100})
            whole,meta,_=await original.whole(1024,'full','managed-parity')
            win=window_for((320,240,384,288),1024,768,16)
            image,_,_=await original.region(original.target(meta,'full',win,16),'managed-parity')
            parity={'whole':differences(whole,diagnostic_pair[0]),'region':differences(image,diagnostic_pair[1])}
            assert parity['whole']['maxLsb']==parity['region']['maxLsb']==0
        return {'backend':backend,'managedParity':parity,'airGroups':air_groups,'guidedChecks':guided_checks,
                'checks':checks,'requestTimings':timings}


async def cross_backend(binary):
    rows, references = [], {}
    with tempfile.TemporaryDirectory(prefix='genzoroom-region-cross-') as folder:
        source=Path(folder)/'scene.png'
        procedural_scene(source)
        for backend in ('off','dx12'):
            session_folder=Path(folder)/backend
            session_folder.mkdir()
            async with Session(binary,backend,session_folder) as s:
                await s.load(source)
                for side in (1024,2048):
                    for nr in (False,True):
                        for amount in (40,100):
                            label=f'{side}-nr{int(nr)}-dehaze{amount}'
                            await s.settings({'effects.dehaze':amount,'detail.nrLuminance':100 if nr else 0,
                                'detail.nrColor':100 if nr else 0})
                            whole,meta,wt=await s.whole(side,'full',label)
                            roi=(side//2-192,side*3//8-144,384,288)
                            win=window_for(roi,side,side*3//4,256)
                            target=s.target(meta,'full',win,256)
                            current,_,_=await s.region(target,label+'-A')
                            common,_,_=await s.region(target,label+'-B',force=wt['used'])
                            for mode,image in [('whole',whole),('regionA',cut(current,roi,win)),('regionB',cut(common,roi,win))]:
                                key=label+'-'+mode
                                if backend=='off':
                                    references[key]=image
                                else:
                                    rows.append({'case':label,'surface':mode,'context':256 if mode!='whole' else None,
                                                 'difference':differences(references[key],image)})
    return rows


def build_provenance():
    import build as managed_build
    from region_root_cause_native import DIAGNOSTIC
    source=ROOT/'.tmp/lightcraft-phase6ar'
    saved=json.loads((source/'region-cause-provenance.json').read_text(encoding='utf-8'))
    module=(source/'crates/pipeline/src/region_cause.rs').read_bytes().replace(b'\r\n',b'\n')
    module_hash=hashlib.sha256(module).hexdigest()
    assert module_hash==saved['diagnosticModuleSha256']==hashlib.sha256(DIAGNOSTIC.encode()).hexdigest()
    assert managed_build.prepare(ROOT/'.tmp/lightcraft-0.14',managed_build.manifest())=='patched'
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    assert commit==MANAGED['commit']
    return {'isolatedSource':'.tmp/lightcraft-phase6ar','isolatedTarget':'.tmp/phase6ar-target',
        'upstreamCommit':commit,'managedPatches':saved['managedPatches'],'diagnosticModuleSha256':module_hash,
        'generatorSha256':hashlib.sha256((ROOT/'native/lightcraft/region_root_cause_native.py').read_bytes()).hexdigest(),
        'buildCommand':'cargo build --offline --locked --release --no-default-features -p lightcraft-cli --target-dir <isolated-target>',
        'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),
        'cargo':subprocess.check_output(['cargo','--version'],text=True).strip(),
        'managedCheckoutVerifiedUnchanged':True,'productionReceiptForDiagnostic':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--json-out',type=Path,required=True)
    parser.add_argument('--performance-only',action='store_true',help='Append cache/memory verification without repeating image experiments')
    parser.add_argument('--cross-only',action='store_true',help='Append direct CPU/DX12 image comparisons')
    args=parser.parse_args()
    binary=args.binary.resolve()
    assert binary.is_relative_to(ROOT/'.tmp/phase6ar-target')
    managed=Path(resolve_managed_executable({},'win32'))
    digest=hashlib.sha256(managed.read_bytes()).hexdigest()
    assert verified_artifact(managed,digest,MANAGED['version']) is not None
    if args.performance_only or args.cross_only:
        report=json.loads(args.json_out.read_text(encoding='utf-8'))
        assert report['diagnosticBinarySha256']==hashlib.sha256(binary.read_bytes()).hexdigest()
        assert report['managedBinarySha256']==digest
        if args.cross_only:
            report['cpuDx12Comparisons']=asyncio.run(cross_backend(binary))
        else:
            report['performanceRecheck']=[asyncio.run(experiments(binary,managed,b,True)) for b in ('off','dx12')]
        report['diagnosticBuild']=build_provenance()
        write_report(args.json_out,report)
        print('Focused recheck recorded')
        return
    report={'version':MANAGED['version'],'commit':MANAGED['commit'],'managedBinarySha256':digest,
        'diagnosticBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
        'source':'Phase6A procedural_scene 2048x1536; no camera RAW',
        'limitations':['VRAM unmeasured','process peak is cumulative, not per-request peak',
            'diagnostic file IO included in request timing','B includes no cost to obtain Whole air from scratch'],
        'results':[asyncio.run(experiments(binary,managed,b)) for b in ('off','dx12')]}
    report['diagnosticBuild']=build_provenance()
    write_report(args.json_out,report)
    print(json.dumps({'groups':sum(len(r['airGroups']) for r in report['results']),
        'comparisons':sum(len(r['checks']) for r in report['results']),'guidedComparisons':sum(len(r['guidedChecks']) for r in report['results'])}))


if __name__=='__main__':
    main()
