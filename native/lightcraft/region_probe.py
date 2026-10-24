"""Probe the built Region tool through the same bounded MCP transport as the Backend."""
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import random
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from lightcraft_mcp import LightCraftMCP, MCPToolError
from lightcraft_runtime import child_environment
from raw_region import MAX_LINE_BYTES, MAX_PNG_BYTES, supports_region, validate_result


async def _probe(binary, backend):
    with tempfile.TemporaryDirectory(prefix='genzoroom-region-') as folder:
        source=Path(folder)/'noise.png'
        Image.frombytes('RGB',(2048,1536),random.Random(17).randbytes(2048*1536*3)).save(source)
        process=await asyncio.create_subprocess_exec(str(binary),'mcp','--headless','--compact',
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,
            limit=24*1024**2,env=child_environment(os.environ,gpu_backend=backend,temp_directory=folder),
            **({'creationflags':0x08000000} if os.name=='nt' else {}))
        client=LightCraftMCP(process.stdout,process.stdin,1)
        try:
            await client.initialize('c1-probe',timeout=30)
            tools=await client.request('tools/list',timeout=10)
            if not supports_region(tools):
                raise ValueError('binary Region capability mismatch')
            async def command(name,params):
                return await client.call_tool('command_run',{'id':name,'params':params},timeout=90)
            if backend=='dx12':
                status=await command('app.gpu',{})
                if status.get('available') is not True:
                    print('SKIP Region DX12 integration: no available adapter')
                    return {'backend':backend,'skipped':'no_adapter'}
            await command('app.memoryBudget',{'mb':1024})
            imported=await command('library.import',{'paths':[str(source)],'mode':'add'})
            photo=imported['imported'][0]
            await command('library.select',{'ids':[photo],'active':photo,'mode':'replace'})
            baseline=await command('beforeAfter.setBefore',{'source':'import'})
            await command('develop.set',{'values':{'light.exposure':0.5}})
            settings=await client.call_tool('get_develop',{'id':photo})
            whole=await client.call_tool_result('render_preview',{'id':photo,'max_side':2048,'quality':'full','preview_contract':1},timeout=90)
            whole_meta=json.loads(next(v['text'] for v in whole['content'] if v['type']=='text'))
            whole_png=base64.b64decode(next(v['data'] for v in whole['content'] if v['type']=='image'))
            geometry=whole_meta['frame']['geometryId']
            identity={'assetId':'12345678-1234-4234-9234-123456789abc','sourceId':hashlib.sha256(source.read_bytes()).hexdigest(),
                'generation':1,'documentToken':'c'*32,'kind':'after','revision':1}
            query={'contractVersion':1,'mode':'region','quality':'full','geometryId':geometry,'identity':identity,
                'documentRevision':1,'viewGeneration':1,'requestId':'d'*32,'desiredLongEdge':2048}
            async def region(operation,target,mode='off',budget=512*1024**2):
                args={'id':str(photo),'region_contract':1,'operation':operation,'target':target,'stage_cache':mode}
                if mode=='on':args['stage_cache_budget_bytes']=budget
                raw=await client.call_tool_result('render_region_preview',args,timeout=90)
                png,meta=validate_result(raw,target,operation,photo,baseline['beforeFingerprint'] if target['identity']['kind']=='before' else None)
                if operation=='render':
                    e=meta['diagnostics']['execution']
                    if e['outcome']!=('gpu_success' if backend=='dx12' else 'cpu_not_tried'):
                        raise ValueError('Region execution backend mismatch')
                return png,meta
            _,plan=await region('plan',query)
            p=plan['response']
            if (p['nativeWidth'],p['nativeHeight'],p['fullWidth'],p['fullHeight'])!=(2048,1536,2048,1536):
                raise ValueError('Region native preflight mismatch')
            target={k:v for k,v in query.items() if k!='desiredLongEdge'}
            target.update(fullWidth=p['fullWidth'],fullHeight=p['fullHeight'],window={'x':512,'y':320,'w':512,'h':384},
                validRegion={'x':576,'y':384,'w':384,'h':256},context=64,prefetch=0)
            off,off_meta=await region('render',target)
            draft=copy.deepcopy(target);draft['quality']='draft'
            _,draft_meta=await region('render',draft,'on')
            full,full_meta=await region('render',target,'on')
            if off!=full or draft_meta['response']['window']!=full_meta['response']['window']:
                raise ValueError('Region cache or Draft/Full geometry mismatch')
            cache=full_meta['diagnostics']['stageCache']
            if cache['retainedBytes']>512*1024**2:
                raise ValueError('Region cache exceeded finite budget')
            _,tiny=await region('render',target,'on',1)
            if tiny['diagnostics']['stageCache']['applied'] or tiny['diagnostics']['stageCache']['reason']!='budget':
                raise ValueError('Region tiny cache admission not declined')
            await region('render',target,'on')
            before=copy.deepcopy(target)
            before['identity']={k:v for k,v in identity.items() if k!='revision'}
            before['identity'].update(kind='before',beforeKey='f'*64)
            before_png,before_meta=await region('render',before,'on')
            if len(before_png)==0 or before_png==full or before_meta['response']['width']!=target['window']['w']:
                raise ValueError('Before Region pair mismatch')
            before_draft=copy.deepcopy(before);before_draft['quality']='draft'
            _,before_draft_meta=await region('render',before_draft,'on')
            if any(before_draft_meta['response'][k]!=before_meta['response'][k] for k in ('geometryId','fullWidth','fullHeight','window','validRegion','width','height')):
                raise ValueError('Before Draft/Full Region geometry changed')
            a=Image.open(io.BytesIO(full)).convert('RGB')
            ref=Image.open(io.BytesIO(whole_png)).convert('RGB').crop((512,320,1024,704))
            diffs=[abs(x-y) for x,y in zip(a.crop((64,64,448,320)).tobytes(),ref.crop((64,64,448,320)).tobytes())]
            inner=max(diffs)
            if inner>1:raise ValueError('Region basic-correction pixels differ from Whole reference')
            malformed=[{'region_contract':2},{'operation':'unknown'},{'private':'rejected'}, {'operation':'plan','target':target}]
            oversized=copy.deepcopy(target);oversized['window']['w']=2049
            malformed.append({'target':oversized})
            for patch in malformed:
                args={'id':str(photo),'region_contract':1,'operation':'render','target':target}|patch
                try:
                    await client.call_tool_result('render_region_preview',args,timeout=30)
                except MCPToolError as error:
                    if error.code!='raw_region_invalid_request':raise
                else:raise ValueError('malformed Region request accepted')
            if await client.call_tool('get_develop',{'id':photo})!=settings:
                raise ValueError('Region operations mutated Develop settings')
            returned_whole=await client.call_tool_result('render_preview',{'id':photo,'max_side':2048,'quality':'full','preview_contract':1,
                'stage_cache':'on','stage_cache_budget_bytes':512*1024**2},timeout=90)
            if base64.b64decode(next(v['data'] for v in returned_whole['content'] if v['type']=='image'))!=whole_png:
                raise ValueError('Region to Whole cache transition changed pixels')
            # Max-area noise verifies real bytes, separately from deliberate oversized-buffer unit tests.
            await command('develop.set',{'values':{'light.exposure':0.0}})
            noise=copy.deepcopy(target);noise.update(window={'x':0,'y':256,'w':2048,'h':1024},
                validRegion={'x':0,'y':320,'w':2048,'h':896})
            settings2=await client.call_tool('get_develop',{'id':photo})
            noise_png,noise_meta=await region('render',noise)
            envelope=len(base64.b64encode(noise_png))+len(json.dumps(noise_meta).encode())+4096
            if not 5*1024**2<len(noise_png)<=MAX_PNG_BYTES or envelope>MAX_LINE_BYTES:
                raise ValueError('Region noise envelope probe failed')
            if await client.call_tool('get_develop',{'id':photo})!=settings2:
                raise ValueError('Region noise operation mutated settings')
            large=Path(folder)/'full-source.png'
            Image.new('RGB',(3072,2304),(80,110,140)).save(large)
            second=(await command('library.import',{'paths':[str(large)],'mode':'add'}))['imported'][0]
            await command('library.select',{'ids':[second],'active':second,'mode':'replace'})
            bootstrap=await client.call_tool_result('render_preview',{'id':second,'max_side':2048,'quality':'full','preview_contract':1},timeout=90)
            bootstrap_meta=json.loads(next(v['text'] for v in bootstrap['content'] if v['type']=='text'))
            # The shared helper now addresses the second source, still on this one serial native session.
            photo=second
            large_query=copy.deepcopy(query);large_query.update(geometryId=bootstrap_meta['frame']['geometryId'],desiredLongEdge=2800)
            large_query['identity']['sourceId']=hashlib.sha256(large.read_bytes()).hexdigest()
            large_settings=await client.call_tool('get_develop',{'id':photo})
            _,large_plan=await region('plan',large_query)
            lp=large_plan['response']
            if large_plan['diagnostics']['sourceLevel']!='Full' or (lp['fullWidth'],lp['fullHeight'])!=(2800,2100):
                raise ValueError('Region full source selection mismatch')
            large_target={k:v for k,v in large_query.items() if k!='desiredLongEdge'}
            large_target.update(fullWidth=lp['fullWidth'],fullHeight=lp['fullHeight'],window={'x':1024,'y':768,'w':512,'h':384},
                validRegion={'x':1088,'y':832,'w':384,'h':256},context=64,prefetch=0)
            await region('render',large_target,'on')
            if await client.call_tool('get_develop',{'id':photo})!=large_settings:
                raise ValueError('Full-source Region changed settings')
            summary={'backend':backend,'nativeFrame':[2048,1536],'window':target['window'],'innerMax':inner,
                'execution':full_meta['diagnostics']['execution'],'stageCache':cache,
                'sourceHostBytes':full_meta['diagnostics']['sourceHostBytes'],'noisePngBytes':len(noise_png),'envelopeBytes':envelope,
                'fullSourceFrame':[lp['fullWidth'],lp['fullHeight']],
                'fullSourceHostBytes':large_plan['diagnostics']['sourceHostBytes'],'settingsUnchanged':True}
            print('Region binary probe '+json.dumps(summary,separators=(',',':')))
            return summary
        finally:
            await client.close()
            try:await asyncio.wait_for(process.wait(),5)
            except TimeoutError:
                process.kill();await process.wait()


def probe_region(binary):
    summaries=[asyncio.run(_probe(binary,'off'))]
    if os.name=='nt':summaries.append(asyncio.run(_probe(binary,'dx12')))
    return summaries
