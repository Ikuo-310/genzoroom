import { RawFailure,rawFailureCode } from './RawFailure';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

type CloseGuard = { prepare: (retry?:boolean) => Promise<boolean>; resume: () => void; discard?:()=>Promise<void>; failureCode?:()=>string|undefined };
type Message = { kind: 'ready' | 'restart' | 'close' } | { kind: 'closeResult'; requestId: string; saved: boolean; discarded?:true };
declare global {
  interface Window { __GENZOROOM_DESKTOP__?: {
    respond: (message: Message) => Promise<void>;
    setMenuLanguage?: (language: 'en' | 'ja') => Promise<void>;
  } }
}
const Context = createContext<(guard: CloseGuard) => () => void>(() => () => {});

export function useDesktopCloseGuard(guard: CloseGuard) {
  const register = useContext(Context);
  const current = useRef(guard);
  current.current = guard;
  useLayoutEffect(() => register({ prepare: retry => current.current.prepare(retry), resume: () => current.current.resume(),failureCode:()=>current.current.failureCode?.(), discard:guard.discard?()=>current.current.discard!():undefined }), [register,!!guard.discard]);
}

export function DesktopLifecycleProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const guard = useRef<CloseGuard | null>(null);
  const register = useRef((value: CloseGuard) => {
    guard.current = value;
    return () => { if (guard.current === value) guard.current = null; };
  }).current;
  const pending = useRef<string | null>(null);
  const activeGuard = useRef<CloseGuard | null>(null);
  const failedGuard=useRef<CloseGuard|null>(null),discardNext=useRef<CloseGuard|null>(null),retryNext=useRef(false);
  const [errorCode,setErrorCode]=useState<string>();
  const actionBusy=useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'waiting' | 'failed' | 'backendFailed' | 'startupFailed' | 'confirmDiscard'>('idle');
  const busy = phase === 'saving' || phase === 'waiting';

  useLayoutEffect(() => {
    if (!window.__GENZOROOM_DESKTOP__) return;
    const appRoot = document.getElementById('root');
    // A host that has not accepted Ready cannot safely know whether React became editable.
    appRoot?.setAttribute('inert', '');
    return () => appRoot?.removeAttribute('inert');
  }, []);

  useEffect(() => {
    const bridge = window.__GENZOROOM_DESKTOP__;
    if (!bridge) return;
    const appRoot = document.getElementById('root');
    let mounted = true;
    const fail = (backendFailed = false, requestId?: string) => {
      if (requestId && pending.current !== requestId) return;
      if(activeGuard.current)failedGuard.current=activeGuard.current;
      activeGuard.current?.resume();
      activeGuard.current = null;
      pending.current = null;
      if (mounted) setPhase(backendFailed ? 'backendFailed' : 'failed');
    };
    const request = (event: Event) => {
      const requestId: unknown = (event as CustomEvent).detail?.requestId;
      if (typeof requestId !== 'string' || !/^[0-9a-f]{64}$/.test(requestId) || pending.current) return;
      pending.current = requestId;
      activeGuard.current = guard.current;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPhase('saving');
      void (async () => {
        let saved = false,discarded=false;
        try {
          // Let the modal freeze input before the owning workspace captures its final snapshot.
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
          if(discardNext.current && discardNext.current===activeGuard.current){discarded=true;discardNext.current=null;}
          else if(!actionBusy.current || retryNext.current){const retry=retryNext.current;retryNext.current=false;saved = await (activeGuard.current?.prepare(retry) ?? Promise.resolve(true));
            if(!saved){const code=activeGuard.current?.failureCode?.();if(code)setErrorCode(code);}}
        } catch(cause) {setErrorCode(rawFailureCode(cause)); saved = false; }
        if (!mounted || pending.current !== requestId) return;
        if (saved || discarded) setPhase('waiting');
        else fail();
        try { await bridge.respond({ kind: 'closeResult', requestId, saved, ...(discarded?{discarded:true as const}:{}) }); }
        catch { fail(false, requestId); }
      })();
    };
    const cancelled = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const requestId = detail?.requestId;
      if (typeof requestId === 'string') {
        if (pending.current !== requestId) return;
      } else if (pending.current) return;
      fail(detail?.code === 'backend_exited_unexpectedly', typeof requestId === 'string' ? requestId : undefined);
    };
    window.addEventListener('genzoroom:close-request', request);
    window.addEventListener('genzoroom:close-cancelled', cancelled);
    void bridge.respond({ kind: 'ready' }).then(() => {
      appRoot?.removeAttribute('inert');
    }).catch(() => {
      if (!pending.current && mounted) setPhase('startupFailed');
    });
    return () => {
      mounted = false;
      window.removeEventListener('genzoroom:close-request', request);
      window.removeEventListener('genzoroom:close-cancelled', cancelled);
    };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (phase !== 'idle' && element && !element.open) element.showModal();
    if (phase === 'idle') {
      element?.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    }
  }, [phase]);
  useEffect(() => {
    if (!busy) return;
    const block = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', block, true);
    window.addEventListener('keyup', block, true);
    return () => { window.removeEventListener('keydown', block, true); window.removeEventListener('keyup', block, true); };
  }, [busy]);

  const requestAgain=async()=>{
    if(actionBusy.current)return;actionBusy.current=true;
    retryNext.current=true;setPhase('saving');
    try{await window.__GENZOROOM_DESKTOP__!.respond({kind:'close'});}catch(cause){setErrorCode(rawFailureCode(cause));setPhase('failed');}finally{actionBusy.current=false;}
  };
  const discardAndClose=async()=>{
    const owner=failedGuard.current;
    if(!owner?.discard || owner!==guard.current || actionBusy.current)return;
    actionBusy.current=true;
    setPhase('saving');
    try{
      await owner.discard();
      // This explicit disposition is consumed by a fresh host request; saved stays false.
      discardNext.current=owner;
      await window.__GENZOROOM_DESKTOP__!.respond({kind:'close'});
    }catch(cause){setErrorCode(rawFailureCode(cause));setPhase('failed');}finally{actionBusy.current=false;}
  };
  return <Context.Provider value={register}>{children}
    {/* Shortcut guards treat ARIA dialogs as active, so idle lifecycle UI must leave the DOM. */}
    {typeof window !== 'undefined' && window.__GENZOROOM_DESKTOP__ && phase !== 'idle' && createPortal(<dialog ref={dialog} className="workspace-save-dialog"
      role={busy ? 'dialog' : 'alertdialog'} aria-label={t('desktopLifecycle.title')}
      onCancel={event => { event.preventDefault(); if (!busy && phase !== 'startupFailed') setPhase('idle'); }}>
      <p role={busy ? 'status' : undefined}>{t(`desktopLifecycle.${phase}`)}</p>
      {!busy && <RawFailure code={errorCode}/>}
      {!busy && phase !== 'startupFailed' && phase!=='confirmDiscard' && <button type="button" className="tool-button" autoFocus onClick={() => setPhase('idle')}>{t('desktopLifecycle.back')}</button>}
      {phase==='failed' && <>
        <button type="button" className="tool-button" onClick={()=>void requestAgain()}>{t('workspace.rawPreview.retrySave')}</button>
        {failedGuard.current?.discard && <button type="button" className="tool-button" onClick={()=>setPhase('confirmDiscard')}>{t('desktopLifecycle.discard')}</button>}
      </>}
      {phase==='confirmDiscard' && <>
        <button type="button" className="tool-button" onClick={()=>setPhase('failed')}>{t('workspace.rawFailure.cancelDiscard')}</button>
        <button type="button" className="tool-button" onClick={()=>void discardAndClose()}>{t('workspace.rawFailure.confirmDiscard')}</button>
      </>}

    </dialog>, document.body)}
  </Context.Provider>;
}
