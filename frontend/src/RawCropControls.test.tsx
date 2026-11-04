import styleCss from './style.css?raw';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { RawCropControls,RawEditCategories,customCropRatio,cropPreset,CROP_PRESETS } from './RawCropControls';
import i18n from './i18n';
let host:HTMLDivElement,root:Root;
let raw: any;
beforeEach(async()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await i18n.changeLanguage('en');
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 raw={status:'ready',settings:{orientation:'Rotate90',crop:{geometry:{rect:{x0:.2,y0:.2,x1:.8,y1:.8},angle:0},aspect:null,flip_h:false,flip_v:false}},
  frame:{nativeWidth:3000,nativeHeight:4000},history:{},crop:{active:true,surface:{},overlay:'thirds',setOverlay:vi.fn(),straightenTool:false,setStraightenTool:vi.fn(),cancel:vi.fn(async()=>{}),begin:vi.fn(async()=>{}),update:vi.fn(),end:vi.fn(async()=>{}),operate:vi.fn(async()=>{}),recover:vi.fn(async()=>{}),setMode:vi.fn(async()=>{})},retrySave:vi.fn(async()=>{})};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const render=async()=>act(async()=>root.render(<RawCropControls raw={raw}/>));
const button=(label:string)=>Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!;
async function input(element:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});}
it.each(CROP_PRESETS.filter(p=>p!=='custom'))('sends Native aspect preset %s with crop orientation',async(preset)=>{
 await render();const select=host.querySelector('select')!;
 await act(async()=>{select.value=preset;select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(raw.crop.operate).toHaveBeenCalledWith({type:'aspect',params:{aspect:preset,orientation:'crop'}},undefined);
});
it('reduces decimal custom ratios exactly and refuses unsupported/invalid inputs',()=>{
 expect(customCropRatio('8.5','11')).toEqual([17,22]);expect(customCropRatio('8.5e-2','11e-2')).toEqual([17,22]);expect(customCropRatio('0.85','1.10')).toEqual([17,22]);
 for(const pair of [['0','1'],['-1','2'],['','2'],['NaN','2'],['Infinity','2'],['1','100'],['.000000001','1']])expect(customCropRatio(...pair as [string,string])).toBeNull();
 expect(cropPreset([2200,1700])).toBe('8.5x11');expect(cropPreset(null)).toBe('free');
});
it('keeps invalid custom drafts local and applies one exact ratio',async()=>{
 await render();const select=host.querySelector('select')!;await act(async()=>{select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));});
 const values=host.querySelectorAll<HTMLInputElement>('.raw-crop-custom input');await input(values[0],'0');await input(values[1],'11');
 expect(button('Apply').disabled).toBe(true);expect(raw.crop.operate).not.toHaveBeenCalled();await input(values[0],'8.5');
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(raw.crop.operate).toHaveBeenCalledWith({type:'aspect',params:{aspect:[17,22],orientation:'crop'}},undefined);
});
it('renders six accessible overlay choices with visible selected styling and no fieldset border',async()=>{
 await render();const group=host.querySelector('fieldset.raw-crop-overlay')!;expect(group.querySelector('legend')!.textContent).toBe('Overlay');
 const choices=Array.from(group.querySelectorAll<HTMLButtonElement>('[aria-pressed]'));
 expect(choices.map(x=>x.textContent)).toEqual(['Thirds','Grid','Golden Ratio','Diagonals','Halves','None']);
 expect(choices.map(x=>x.getAttribute('aria-pressed'))).toEqual(['true','false','false','false','false','false']);
 expect(group.querySelector('button')!.className).toContain('tool-button');
 expect(styleCss).toContain('.raw-crop-overlay { border: 0; padding: 0; margin: 10px 0; min-width: 0; }');
 expect(styleCss).toContain('.raw-crop-overlay .tool-button[aria-pressed="true"] { background: #505050;');
 expect(styleCss).not.toContain('rotateOverlay');expect(group.textContent).not.toContain('Spiral');
 await act(async()=>choices[1].click());expect(choices[1].getAttribute('aria-pressed')).toBe('false');expect(raw.crop.setOverlay).toHaveBeenCalledWith('grid');
});
it('uses the Japanese Free label while keeping the free preset value and English Free',async()=>{
 await i18n.changeLanguage('ja');await render();expect(host.querySelector('select option[value="free"]')!.textContent).toBe('フリー');
 await i18n.changeLanguage('en');await render();expect(host.querySelector('select option[value="free"]')!.textContent).toBe('Free');
});
it('orders the panel groups and uses a properly labeled aspect select outside the chain button',async()=>{
 await render();const select=host.querySelector<HTMLSelectElement>('.raw-crop-aspect-row select')!,label=host.querySelector<HTMLLabelElement>('.raw-crop-aspect label')!;
 expect(label.htmlFor).toBe(select.id);expect(label.contains(select)).toBe(false);expect(label.contains(host.querySelector('.raw-crop-aspect-lock'))).toBe(false);
 const swap=host.querySelector('.raw-crop-aspect-swap')!,straighten=host.querySelector('input[type="range"]')!,tool=button('Straighten Tool');
 expect(swap.compareDocumentPosition(straighten)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(straighten.compareDocumentPosition(tool)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 const rows=host.querySelectorAll('.raw-crop-transform-row');expect(rows).toHaveLength(2);
 expect(rows[0].textContent).toContain('Rotate Left');expect(rows[0].textContent).toContain('Rotate Right');
 expect(rows[1].textContent).toContain('Flip Horizontal');expect(rows[1].textContent).toContain('Flip Vertical');
 const orientation=Array.from(host.querySelectorAll('p')).find(p=>p.textContent?.includes('Orientation'))!;
 const overlays=host.querySelector('fieldset.raw-crop-overlay')!,reset=button('Reset Crop');
 expect(orientation.compareDocumentPosition(overlays)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(overlays.compareDocumentPosition(reset)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(host.textContent).not.toContain('Positive angles rotate clockwise');
 expect(host.querySelectorAll('.raw-crop-aspect-lock svg path').length).toBeGreaterThan(1);expect(host.querySelector('.raw-crop-aspect-lock svg')!.getAttribute('viewBox')).toBe('0 0 24 24');
});
it('uses one chain button for aspect lock and derives its state from readback',async()=>{
 await render();const select=host.querySelector('select')!,chain=host.querySelector<HTMLButtonElement>('.raw-crop-aspect-lock')!;
 expect(select.parentElement!.className).toBe('raw-crop-aspect-row');expect(select.querySelector('option[value="original"]')).toBeNull();
 expect(chain.getAttribute('aria-pressed')).toBe('false');expect(chain.getAttribute('aria-label')).toBe('Lock current aspect ratio');
 await act(async()=>chain.click());expect(raw.crop.operate).toHaveBeenCalledOnce();expect(raw.crop.operate).toHaveBeenCalledWith({type:'aspect',params:{aspect:'current'}},'lock');
 raw.settings.crop.aspect=[1600,900];await render();expect(chain.getAttribute('aria-pressed')).toBe('true');expect(chain.getAttribute('aria-label')).toBe('Unlock aspect ratio');expect(select.value).toBe('16x9');
 await act(async()=>chain.click());expect(raw.crop.operate).toHaveBeenLastCalledWith({type:'aspect',params:{aspect:'free'}},'unlock');
});
it.each(['Swap Aspect','Rotate Left 90°','Rotate Right 90°','Flip Horizontal','Flip Vertical','Reset Crop'])('dispatches %s once while the outcome is pending',async(label)=>{
 let resolve!:()=>void;raw.crop.operate.mockImplementation(()=>new Promise<void>(r=>resolve=r));await render();
 await act(async()=>{button(label).click();button(label).click();});expect(raw.crop.operate).toHaveBeenCalledOnce();
 const call=raw.crop.operate.mock.calls[0];const types:any={'Swap Aspect':'swap','Rotate Left 90°':'rotateLeft','Rotate Right 90°':'rotateRight','Flip Horizontal':'flipHorizontal','Flip Vertical':'flipVertical','Reset Crop':'reset'};
 expect(call[0].type).toBe(types[label]);
 await act(async()=>resolve());
});
it('reads Native lock/flip state and labels chain unlock accessibly',async()=>{
 raw.settings.crop.aspect=[1700,2200];raw.settings.crop.flip_h=true;await render();
 expect(host.querySelector('select')!.value).toBe('8.5x11');expect(button('Flip Horizontal').getAttribute('aria-pressed')).toBe('true');
 const chain=host.querySelector<HTMLButtonElement>('.raw-crop-aspect-lock')!;expect(chain.getAttribute('aria-pressed')).toBe('true');expect(chain.getAttribute('aria-label')).toBe('Unlock aspect ratio');
 await act(async()=>chain.click());expect(raw.crop.operate).toHaveBeenCalledWith({type:'aspect',params:{aspect:'free'}},'unlock');
});
it('disables discrete actions and slider while a frame gesture owns the document',async()=>{
 raw.locked=true;raw.crop.operation='drag';await render();
 expect(button('Reset Crop').disabled).toBe(true);expect(host.querySelector<HTMLInputElement>('input[type=range]')!.disabled).toBe(true);
});
it.each(['pointerup','pointercancel','blur','lostpointercapture'])('settles one Straighten gesture at %s with the final input',async(end)=>{
 await render();const range=host.querySelector<HTMLInputElement>('input[type=range]')!;
 await act(async()=>{const e=new Event('pointerdown',{bubbles:true});Object.assign(e,{button:0});range.dispatchEvent(e);});
 await input(range,'-45');await input(range,'45');
 await act(async()=>end==='lostpointercapture'?range.dispatchEvent(new Event(end,{bubbles:true})):window.dispatchEvent(new Event(end)));
 expect(raw.crop.begin).toHaveBeenCalledWith('straighten');expect(raw.crop.update).toHaveBeenLastCalledWith({type:'straighten',params:{angle:45}});
 if(end==='pointerup')expect(raw.crop.end).toHaveBeenCalledOnce();else {expect(raw.crop.cancel).toHaveBeenCalledOnce();expect(raw.crop.end).not.toHaveBeenCalled();}
});
it('offers explicit recovery on a failed relative mutation without automatically resending it',async()=>{
 raw.crop.operate.mockRejectedValue(new Error('unknown'));await render();await act(async()=>button('Rotate Right 90°').click());
 expect(host.textContent).toContain('could not be confirmed');expect(raw.crop.operate).toHaveBeenCalledOnce();
 await act(async()=>button('Recover saved recipe').click());expect(raw.crop.recover).toHaveBeenCalledOnce();expect(raw.crop.operate).toHaveBeenCalledOnce();
});
it('switches categories after committing inputs and retains confirmed selection until completion',async()=>{
 raw.crop.active=false;const commit=vi.fn();let resolve!:()=>void;raw.crop.setMode.mockImplementation(()=>new Promise<void>(r=>resolve=r));
 await act(async()=>root.render(<RawEditCategories raw={raw} disabled={false} commit={commit}/>));
 const radios=host.querySelectorAll<HTMLInputElement>('input[type=radio]');expect(radios[0].checked).toBe(true);
 await act(async()=>radios[1].click());expect(commit).toHaveBeenCalledOnce();expect(raw.crop.setMode).toHaveBeenCalledWith(true);
 expect(radios[0].checked).toBe(true);expect(radios[1].disabled).toBe(true);await act(async()=>resolve());
 raw.saveError='unknown';await act(async()=>root.render(<RawEditCategories raw={raw} disabled={false} commit={commit}/>));expect(radios[1].disabled).toBe(true);
});

it('commits numeric Straighten and its local final draft on blur',async()=>{
 await render();const number=host.querySelector<HTMLInputElement>('.adjustment-number')!;await act(async()=>number.focus());await input(number,'-12.3');
 await act(async()=>number.blur());expect(raw.crop.update).toHaveBeenLastCalledWith({type:'straighten',params:{angle:-12.3}});expect(raw.crop.end).toHaveBeenCalledOnce();
});
it('drains a live Straighten gesture when its panel unmounts',async()=>{
 await render();const range=host.querySelector<HTMLInputElement>('input[type=range]')!;
 await act(async()=>{const e=new Event('pointerdown',{bubbles:true});Object.assign(e,{button:0});range.dispatchEvent(e);});await input(range,'15');
 await act(async()=>root.render(<div/>));expect(raw.crop.cancel).toHaveBeenCalledOnce();expect(raw.crop.end).not.toHaveBeenCalled();
});
it('rebinds Custom and Straighten display from readback after Undo',async()=>{
 raw.settings.crop.aspect=[1300,1700];raw.settings.crop.geometry.angle=12;await render();
 expect(host.querySelector('select')!.value).toBe('custom');expect(host.querySelector<HTMLInputElement>('.raw-crop-custom input')!.value).toBe('13');
 raw.settings.crop.aspect=[2200,1700];raw.settings.crop.geometry.angle=0;await render();
 expect(host.querySelector('select')!.value).toBe('8.5x11');expect(host.querySelector<HTMLInputElement>('.adjustment-number')!.value).toBe('0.0');
});

it('scopes dark native select and option styling to Crop, including focus and disabled states',()=>{
 const rules=styleCss.split('\n').filter(line=>line.startsWith('.raw-crop-aspect select')).join('\n');
 expect(rules).toContain('color-scheme: dark');expect(rules).toContain('background: #252528');expect(rules).toContain('color: #eee');
 expect(rules).toContain('select option');expect(rules).toContain('select:focus-visible');expect(rules).toContain('select:disabled');
});

it('clears a rejected preflight angle owner so the renewed document can accept another gesture',async()=>{
 raw.crop.begin.mockRejectedValueOnce(Object.assign(new Error('renew'),{code:'raw_session_regeneration_required'}));await render();
 const range=host.querySelector<HTMLInputElement>('input[type=range]')!;await act(async()=>{const e=new Event('pointerdown',{bubbles:true});Object.assign(e,{button:0});range.dispatchEvent(e);});
 raw.locked=true;await render();raw.locked=false;raw.crop={...raw.crop,begin:vi.fn(async()=>{})};await render();await act(async()=>{const e=new Event('pointerdown',{bubbles:true});Object.assign(e,{button:0});range.dispatchEvent(e);});await input(range,'30');
 expect(raw.crop.begin).toHaveBeenCalledOnce();await act(async()=>window.dispatchEvent(new Event('pointerup')));expect(raw.crop.end).toHaveBeenCalledOnce();
});
