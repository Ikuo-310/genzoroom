import { useEffect, useRef, useState } from 'react';
import { createRawWorkspace, openRawDocument, rawCapability, rawPreview, readRawDocument,
  releaseRawWorkspace, RawApiError, type RawDocument } from './rawApi';
import { frontendLogger } from './frontendLogging';

type RawState = { assetId: string; status: 'loading' | 'ready' | 'unavailable' | 'error';
  url?: string; document?: RawDocument; code?: string };
// Serialize ownership changes even when React unmounts during a transmitted import.
let ownership = Promise.resolve();
function enqueue(action: () => Promise<void>) { ownership = ownership.then(action, action).catch(() => {}); }
function log(code: string) {
  try { frontendLogger.add({ level: 'error', component: 'raw', event: 'preview.failed', context: { errorCode: code } }); }
  catch { /* Diagnostics cannot change Preview ownership. */ }
}

export function useRawDocument(assetId: string | null) {
  const [state, setState] = useState<RawState | null>(null);
  const serial = useRef(0);
  const identity = useRef(assetId);
  identity.current = assetId;
  useEffect(() => {
    if (!assetId) { setState(null); return; }
    const currentSerial = ++serial.current;
    let active = true, available = false, workspace: string | undefined, url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const current = () => active && identity.current === assetId && serial.current === currentSerial;
    const revoke = () => { if (url) URL.revokeObjectURL(url); url = undefined; };
    const fail = (error: unknown) => {
      if (!current()) return;
      revoke();
      const code = error instanceof RawApiError ? error.code : 'raw_connection_failed';
      const unavailable = !available && (code === 'raw_unsupported' || code === 'raw_unavailable');
      if (!unavailable) log(code);
      setState({ assetId, status: unavailable ? 'unavailable' : 'error', code });
    };
    setState({ assetId, status: 'loading' });
    enqueue(async () => {
      try {
        if (!current()) return;
        if (!await rawCapability(controller.signal)) throw new RawApiError('raw_unavailable');
        available = true;
        if (!current()) return;
        workspace = await createRawWorkspace();
        if (!current()) return;
        const doc = await openRawDocument(workspace, assetId);
        if (!current()) return;
        const frame = await rawPreview(doc, currentSerial, controller.signal);
        if (!current()) return;
        url = URL.createObjectURL(frame.blob);
        const image = new Image();
        image.src = url;
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
          let removeAbort = () => {};
          try {
            await Promise.race([image.decode(), new Promise<never>((_, reject) => {
              const abort = () => reject(new RawApiError('raw_decode_cancelled'));
              signal.addEventListener('abort', abort, { once: true });
              removeAbort = () => signal.removeEventListener('abort', abort);
              if (signal.aborted) abort();
            })]);
          } finally { removeAbort(); }
          if (!current()) { revoke(); return; }
          if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new RawApiError('raw_invalid_response');
        } finally { image.removeAttribute('src'); }
        // Recheck engine identity after decode, before publishing a native result.
        await readRawDocument(doc, controller.signal);
        if (!current()) { revoke(); return; }
        setState({ assetId, status: 'ready', url, document: doc });
        const heartbeat = async () => {
          try { await readRawDocument(doc, controller.signal); }
          catch (error) { fail(error); return; }
          if (current()) timer = setTimeout(() => void heartbeat(), 30_000);
        };
        timer = setTimeout(() => void heartbeat(), 30_000);
      } catch (error) { fail(error); }
      finally {
        if (!current() && workspace) {
          try { await releaseRawWorkspace(workspace); workspace = undefined; } catch { log('raw_release_failed'); }
        }
      }
    });
    const dispose = () => {
      if (!active) return;
      active = false;
      controller.abort();
      clearTimeout(timer);
      revoke();
      enqueue(async () => {
        if (workspace) {
          try { await releaseRawWorkspace(workspace); } catch { log('raw_release_failed'); }
          workspace = undefined;
        }
      });
    };
    const pagehide = () => {
      if (current()) setState({ assetId, status: 'error', code: 'raw_document_closed' });
      dispose();
    };
    window.addEventListener('pagehide', pagehide);
    return () => { window.removeEventListener('pagehide', pagehide); dispose(); };
  }, [assetId]);
  // A route change hides the old image before effect cleanup runs.
  return assetId ? state?.assetId === assetId ? state : { assetId, status: 'loading' as const } : null;
}
