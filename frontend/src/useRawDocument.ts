import { useEffect, useRef, useState } from 'react';
import { createRawWorkspace, openRawDocument, rawCapability, rawPreview, readRawDocument, readRawSettings,
  releaseRawWorkspace, RawApiError, type RawDocument, type RawSettings, type RawValues } from './rawApi';
import { frontendLogger } from './frontendLogging';
import { RawControls } from './rawControls';

type RawState = { assetId: string; status: 'loading' | 'ready' | 'unavailable' | 'error';
  url?: string; document?: RawDocument; code?: string; settings?: RawSettings;
  desired?: Partial<RawValues>; pending?: boolean; editError?: string };
// Serialize ownership changes even when React unmounts during a transmitted import.
let ownership = Promise.resolve();
function enqueue(action: () => Promise<void>) { ownership = ownership.then(action, action).catch(() => {}); }
function log(code: string, event = 'preview.failed') {
  try { frontendLogger.add({ level: 'error', component: 'raw', event, context: { errorCode: code } }); }
  catch { /* Diagnostics cannot change Preview ownership. */ }
}

export function useRawDocument(assetId: string | null) {
  const [state, setState] = useState<RawState | null>(null);
  const serial = useRef(0);
  const identity = useRef(assetId);
  const editorRef = useRef<RawControls | null>(null);
  identity.current = assetId;
  useEffect(() => {
    if (!assetId) { setState(null); return; }
    const currentSerial = ++serial.current;
    let active = true, available = false, workspace: string | undefined, url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let editor: RawControls | undefined;
    let frameSerial = 0;
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
    const displayPreview = async (doc: RawDocument, valid = current) => {
      let candidate: string | undefined;
      try {
        const frame = await rawPreview(doc, ++frameSerial, controller.signal);
        if (!valid()) return;
        candidate = URL.createObjectURL(frame.blob);
        const image = new Image();
        image.src = candidate;
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
          if (!valid()) return;
          if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new RawApiError('raw_invalid_response');
        } finally { image.removeAttribute('src'); }
        // Recheck engine identity after decode, before publishing a native result.
        await readRawDocument(doc, controller.signal);
        if (!valid()) return;
        revoke();
        url = candidate;
        candidate = undefined;
        setState(previous => ({ ...previous, assetId, status: 'ready', url, document: doc }));
      } finally { if (candidate) URL.revokeObjectURL(candidate); }
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
        const settings = await readRawSettings(doc);
        if (!current()) return;
        await displayPreview(settings);
        if (!current()) return;
        editor = new RawControls(settings, { schedule: enqueue,
          changed: () => {
            if (!current() || !editor) return;
            if (editor.error) log(editor.error, 'controls.failed');
            const confirmed = editor.confirmed;
            setState(previous => ({ ...previous, assetId, status: 'ready', document: confirmed, settings: confirmed,
              desired: { ...editor!.desired }, pending: editor!.unsettled, editError: editor!.error }));
          },
          preview: (confirmed, valid) => displayPreview(confirmed, () => current() && valid()),
        });
        editorRef.current = editor;
        setState(previous => ({ ...previous, assetId, status: 'ready', settings }));
        const heartbeat = async () => {
          const attempt = editor!.serial;
          try { if (!editor!.unsettled && !editor!.error) await readRawDocument(editor!.confirmed, controller.signal); }
          catch (error) { if (attempt === editor!.serial) { fail(error); return; } }
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
      editor?.dispose();
      if (editorRef.current === editor) editorRef.current = null;
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
  const visible = assetId ? state?.assetId === assetId ? state : { assetId, status: 'loading' as const } : null;
  // A departing slider's commit callback must never flush the successor document's owner.
  const activeEditor = () => identity.current === assetId && editorRef.current?.confirmed.assetId === assetId ? editorRef.current : null;
  return visible && { ...visible, changeControls: (values: Partial<RawValues>) => activeEditor()?.change(values),
    flushControls: () => activeEditor()?.flush(), retryControls: () => activeEditor()?.retry() };
}
