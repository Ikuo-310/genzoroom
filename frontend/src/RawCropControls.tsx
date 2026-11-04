import { RawFailure,rawFailureCode } from './RawFailure';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdjustmentSlider } from './AdjustmentSlider';
import { commitAdjustmentEdits } from './adjustmentFocus';
import type { RawGeometryOperation, RawGeometryAction } from './rawApi';
import type { useRawDocument } from './useRawDocument';
type Raw = NonNullable<ReturnType<typeof useRawDocument>>;
export const CROP_PRESETS = ['free','original','1x1','4x5','8.5x11','5x7','2x3','4x3','16x9','16x10','custom'] as const;
const presetLabels = ['','','1 × 1','4 × 5 / 8 × 10','8.5 × 11','5 × 7','2 × 3 / 4 × 6','4 × 3','16 × 9','16 × 10',''];
export function customCropRatio(w: string, h: string): [number,number] | null {
  const decimal = (v: string) => {
    const value=v.trim(),m=/^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!m || !(m[1] || m[2]) || value.length > 32 || !Number.isFinite(Number(value)) || Number(value)<=0) return null;
    const exponent=Number(m[3] ?? 0)-(m[2]?.length ?? 0);
    return { n:BigInt((m[1] || '0')+(m[2] || ''))*10n**BigInt(Math.max(0,exponent)), d:10n**BigInt(Math.max(0,-exponent)) };
  };
  const x=decimal(w),y=decimal(h); if(!x || !y || x.n===0n || y.n===0n)return null;
  let a=x.n*y.d,b=y.n*x.d; const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;const g=gcd(a,b);a/=g;b/=g;
  // Native stores round(component * 100) in u32; reduced integer components avoid decimal rounding.
  if(a>42949672n || b>42949672n || a*20n<b || b*20n<a)return null;
  return [Number(a),Number(b)];
}
export function cropPreset(aspect: [number,number] | null, original?: number) {
  if(!aspect)return 'free';const ratio=aspect[0]/aspect[1];
  const matches=(r:number)=>Math.abs(ratio/r-1)<1e-7 || Math.abs(ratio*r-1)<1e-7;
  if(original && matches(original))return 'original';
  return CROP_PRESETS.find(p=>p.includes('x') && matches(Number(p.split('x')[0])/Number(p.split('x')[1]))) ?? 'custom';
}
export function RawEditCategories({ raw, disabled, commit }: { raw:Raw;disabled:boolean;commit:()=>void }) {
  const {t}=useTranslation(),name=useId();const pending=useRef(false),restoreFocus=useRef<HTMLInputElement|null>(null);const [busy,setBusy]=useState(false),[error,setError]=useState(false),[failureCode,setFailureCode]=useState<string>();
  // A transient native disabled state may blur the radio; restore only if no newer focus owner intervened.
  useEffect(()=>{
    if(!busy){const element=restoreFocus.current;restoreFocus.current=null;
      if(element?.isConnected && document.activeElement===document.body)element.focus({preventScroll:true});return;}
    const cancel=(event:Event)=>{if(event.target!==restoreFocus.current && event.target!==document.body)restoreFocus.current=null;};
    document.addEventListener('focusin',cancel);document.addEventListener('pointerdown',cancel);
    return ()=>{document.removeEventListener('focusin',cancel);document.removeEventListener('pointerdown',cancel);};
  },[busy]);
  const locked=disabled || busy || raw.status!=='ready' || !!raw.saveError || !!raw.editError || !!raw.historyError || !!raw.historyLoading
    || !!raw.locked && !raw.crop.operation;
  return <div className="raw-edit-categories" aria-busy={busy}>
    <div className="binary-radio-choice" role="radiogroup" aria-label={t('workspace.rawCrop.category')}><div className="binary-radio-options">
      {[false,true].map(crop=><label key={String(crop)}><input type="radio" name={name} checked={raw.crop.active===crop} disabled={locked}
        onChange={event=>{if(pending.current)return;restoreFocus.current=event.currentTarget;pending.current=true;setBusy(true);setError(false);setFailureCode(undefined);commit();
          void raw.crop.setMode(crop).catch(cause=>{setError(true);setFailureCode(rawFailureCode(cause));}).finally(()=>{pending.current=false;setBusy(false);});}}/>
        <span>{t(crop?'workspace.rawCrop.crop':'workspace.rawCrop.develop')}</span></label>)}
    </div></div>
    {error && <p role="alert" className="error-text">{t('workspace.rawCrop.transitionFailed')}</p>}
  </div>;
}
export function RawCropControls({ raw,disabled=false }: {raw:Raw;disabled?:boolean}) {
  const {t}=useTranslation(),panel=useRef<HTMLDivElement>(null),name=useId();
  const pending=useRef(false),angleOwner=useRef<Raw['crop'] | null>(null),ending=useRef(false);
  const [failureCode,setFailureCode]=useState<string>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(false),[angle,setAngle]=useState<number|null>(null);
  const [custom,setCustom]=useState(false),[w,setW]=useState(''),[h,setH]=useState('');
  const crop=raw.settings?.crop;
  const overlays=['thirds','grid','golden','diagonals','halves','spiral','none'] as const;
  const locked=disabled || busy || !!raw.locked || raw.status!=='ready' || !crop || !raw.crop.surface || raw.crop.canStart === false || !!raw.historyError || !!raw.historyLoading || !!raw.editError;
  const run=(operation:RawGeometryOperation,action?:RawGeometryAction)=>{
    if(pending.current || locked)return;
    if(panel.current)commitAdjustmentEdits(panel.current);
    // Reserve admission before React disables controls, so rapid clicks cannot queue relative commands.
    pending.current=true;setBusy(true);setError(false);setFailureCode(undefined);
    void raw.crop.operate(operation,action).catch(cause=>{setError(true);setFailureCode(rawFailureCode(cause));}).finally(()=>{pending.current=false;setBusy(false);});
  };
  const begin=()=>{
    if(angleOwner.current || pending.current || locked)return;
    const owner=raw.crop;angleOwner.current=owner;setError(false);setFailureCode(undefined);
    void owner.begin('straighten').catch(cause=>{if(angleOwner.current===owner){angleOwner.current=null;setAngle(null);}setError(true);setFailureCode(rawFailureCode(cause));});
  };
  const finish=()=>{
    const owner=angleOwner.current;if(!owner || ending.current)return;ending.current=true;setBusy(true);
    void owner.end().catch(cause=>{setError(true);setFailureCode(rawFailureCode(cause));}).finally(()=>{angleOwner.current=null;ending.current=false;setAngle(null);setBusy(false);});
  };
  const cancel=()=>{const owner=angleOwner.current;if(!owner || ending.current)return;
    angleOwner.current=null;setAngle(null);setBusy(true);
    void owner.cancel().catch(cause=>{setError(true);setFailureCode(rawFailureCode(cause));}).finally(()=>setBusy(false));};
  const sawAngleOwner=useRef(false);
  useEffect(()=>{
    if(raw.crop.operation==='straighten')sawAngleOwner.current=true;
    else if(sawAngleOwner.current && !raw.saveError){
      sawAngleOwner.current=false;angleOwner.current=null;setAngle(null);
    }
  },[raw.crop.operation,raw.saveError]);
  const finishRef=useRef(cancel);finishRef.current=cancel;
  useEffect(()=>{ const blur=()=>finishRef.current();window.addEventListener('blur',blur);
    return ()=>window.removeEventListener('blur',blur); },[]);
  const aspect=crop?.aspect ?? null,preset=cropPreset(aspect,raw.frame?raw.frame.nativeWidth/raw.frame.nativeHeight:undefined);
  useEffect(()=>{
    // Readback/Undo owns confirmed ratio; only the unsent form draft remains local.
    setCustom(false);setW(aspect?String(aspect[0]/100):'');setH(aspect?String(aspect[1]/100):'');
  },[aspect?.[0],aspect?.[1]]);
  const ratio=customCropRatio(w,h);
  // Bubble blur after the number input has submitted its final draft; capture would end the owner too early.
  return <div className="raw-crop-controls" ref={panel} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node | null))finish();}} aria-busy={busy || !!raw.locked}>
    <label className="raw-crop-aspect">{t('workspace.rawCrop.aspect')}<select value={custom?'custom':preset} disabled={locked}
      onChange={event=>{const value=event.target.value;setCustom(value==='custom');if(value!=='custom')run({type:'aspect',params:{aspect:value as 'free',orientation:'crop'}});}}>
      {CROP_PRESETS.map((p,i)=><option key={p} value={p}>{presetLabels[i] || t(`workspace.rawCrop.${p}`)}</option>)}
    </select></label>
    <p className="edit-source-note">{aspect?`${aspect[0]/100} : ${aspect[1]/100}`:t('workspace.rawCrop.free')}</p>
    <fieldset className="raw-crop-overlay"><legend>{t('workspace.rawCrop.overlay')}</legend><div className="raw-crop-buttons">{overlays.map(mode=><button key={mode} type="button" className="tool-button" aria-pressed={raw.crop.overlay===mode} onClick={()=>raw.crop.setOverlay(mode)}>{t(`workspace.rawCrop.overlays.${mode}`)}</button>)}</div>
      {raw.crop.overlay==='spiral'&&<button type="button" className="tool-button" onClick={()=>raw.crop.setSpiralDirection((raw.crop.spiralDirection+90)%360)}>{t('workspace.rawCrop.rotateOverlay')}</button>}</fieldset>
    <div className="raw-crop-buttons">
      <button type="button" className="tool-button" disabled={locked} onClick={()=>run({type:'swap',params:{}})}>{t('workspace.rawCrop.swap')}</button>
      <button type="button" className="tool-button" disabled={locked} aria-pressed={!!aspect}
        onClick={()=>run({type:'aspect',params:{aspect:aspect?'free':'current'}},aspect?'unlock':'lock')}>{t(aspect?'workspace.rawCrop.unlock':'workspace.rawCrop.lock')}</button>
    </div>
    {(custom || preset==='custom') && <form className="raw-crop-custom" onSubmit={event=>{event.preventDefault();if(ratio)run({type:'aspect',params:{aspect:ratio,orientation:'crop'}});}}>
      <label>{t('workspace.rawCrop.width')}<input name={name+'w'} type="number" min="0" step="any" value={w} disabled={locked} onChange={e=>setW(e.target.value)}/></label>
      <span aria-hidden="true">:</span><label>{t('workspace.rawCrop.height')}<input name={name+'h'} type="number" min="0" step="any" value={h} disabled={locked} onChange={e=>setH(e.target.value)}/></label>
      <button type="submit" className="tool-button" disabled={locked || !ratio}>{t('workspace.rawCrop.apply')}</button>
      {(w || h) && !ratio && <p role="alert">{t('workspace.rawCrop.invalidRatio')}</p>}
    </form>}
    <AdjustmentSlider adjustmentId="crop.angle" commitPolicy="operation-boundary" label={t('workspace.rawCrop.straighten')}
      valueLabel={t('workspace.rawCrop.angle')} value={angle ?? crop?.geometry.angle ?? 0} min={-45} max={45} step={.1} precision={1}
      valueText={`${(angle ?? crop?.geometry.angle ?? 0)>0?'+':''}${(angle ?? crop?.geometry.angle ?? 0).toFixed(1)}°`}
      defaultValue={0} resetLabel={t('workspace.rawCrop.zero')} enabled={true} hideToggle={true} valueSuffix="°"
      disabled={locked && !angleOwner.current || busy || ending.current} actionsDisabled={locked}
      onBegin={begin} onChange={value=>{if(!Number.isFinite(value) || value < -45 || value > 45)return;begin();
        if(angleOwner.current && !ending.current){setAngle(value);angleOwner.current.update({type:'straighten',params:{angle:value}});}}}
      onCommit={finish} onCancel={cancel} onReset={()=>run({type:'straighten',params:{angle:0}})}/>
    <button type="button" className="tool-button" aria-pressed={raw.crop.straightenTool}
      disabled={locked} onClick={()=>raw.crop.setStraightenTool(!raw.crop.straightenTool)}>{t('workspace.rawCrop.straightenTool')}</button>
    <p className="edit-source-note">{t('workspace.rawCrop.direction')}</p>
    <div className="raw-crop-buttons">{(['rotateLeft','rotateRight','flipHorizontal','flipVertical'] as const).map(type=><button
      key={type} type="button" className="tool-button" disabled={locked} aria-pressed={type==='flipHorizontal'?crop?.flip_h:type==='flipVertical'?crop?.flip_v:undefined}
      onClick={()=>run({type,params:{}})}>{t(`workspace.rawCrop.${type}`)}</button>)}</div>
    {raw.settings?.orientation && <p className="edit-source-note">{t('workspace.rawCrop.orientation')}: {t(`workspace.rawCrop.orientations.${raw.settings.orientation}`)}</p>}
    <button type="button" className="tool-button raw-crop-reset" disabled={locked} onClick={()=>run({type:'reset',params:{}})}>{t('workspace.rawCrop.reset')}</button>
    {(error || raw.saveError) && <div role="alert"><RawFailure code={failureCode ?? raw.saveError}/><p>{t('workspace.rawCrop.failed')}</p>
      <button type="button" className="tool-button" disabled={busy || disabled} onClick={()=>{if(pending.current)return;pending.current=true;setBusy(true);
        void raw.crop.recover().then(()=>{angleOwner.current=null;setAngle(null);setError(false);}).catch(cause=>{setError(true);setFailureCode(rawFailureCode(cause));}).finally(()=>{pending.current=false;setBusy(false);});}}>{t('workspace.rawCrop.recover')}</button>
      <button type="button" className="tool-button" disabled={busy || disabled} onClick={()=>void raw.retrySave()}>{t('workspace.rawPreview.retrySave')}</button>
    </div>}
    {raw.regenerating && <p role="status">{t('workspace.rawPreview.regenerating')}</p>}
    {raw.regenerationError && <button type="button" className="tool-button" disabled={disabled || raw.regenerating} onClick={raw.retryRegeneration}>{t('workspace.rawPreview.retryRegeneration')}</button>}
    {raw.displayError && <div role="alert"><p>{t('workspace.rawPreview.error')}</p><button type="button" className="tool-button" disabled={disabled || raw.locked} onClick={raw.retryPreview}>{t('workspace.retry')}</button></div>}
  </div>;
}
