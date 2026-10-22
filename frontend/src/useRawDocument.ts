import { useEffect, useRef, useState } from 'react';
import { createRawWorkspace, openRawDocument, rawCapability, rawPreview, readRawDocument, readRawSettings,
  releaseRawWorkspace, rawWorkspaceEmpty, RawApiError, type RawDocument, type RawSettings, type RawValues, type RawControlId,
  type RawHistoryResult, type RawHistoryStep } from './rawApi';
import { frontendLogger } from './frontendLogging';
import { RawControls } from './rawControls';
import { RawRecipeSave } from './rawRecipeSave';

type RawState = { assetId: string; status: 'loading' | 'ready' | 'unavailable' | 'error';
  url?: string; document?: RawDocument; code?: string; settings?: RawSettings;
  desired?: Partial<RawValues>; pending?: boolean; editError?: string; dirty?: boolean;
  saving?: boolean; saveError?: string; locked?: boolean; regenerating?: boolean; regenerationError?: string;
  history?: RawHistoryResult['history']; historySteps?: RawHistoryStep[]; historyOffset?: number;
  historyLoading?: boolean; historyError?: string; canUndo?: boolean; canRedo?: boolean; movingHistory?: boolean };
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
  const saverRef = useRef<RawRecipeSave | null>(null);
  const frozen = useRef(false);
  const restartRef = useRef<(retry?: boolean) => Promise<void>>(async () => {});
  const restartWaitRef = useRef<() => Promise<void>>(async () => {});
  const renewalLockedRef = useRef<() => boolean>(() => false);
  const notifyRef = useRef<() => void>(() => {});
  identity.current = assetId;
  useEffect(() => {
    if (!assetId) { setState(null); return; }
    const currentSerial = ++serial.current;
    let active = true, available = false, workspace: string | undefined, url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let editor: RawControls | undefined;
    let saver: RawRecipeSave | undefined;
    frozen.current = false;
    let frameSerial = 0;
    let restarting = false, regenerationError: string | undefined;
    let restartOperation: Promise<void> | undefined;
    let stage: 'save' | 'release' | 'open' = 'save';
    let expectedFingerprint: string | undefined, expectedRecipeRevision: number | undefined;
    let oldGeneration: number | undefined;
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
      if (!valid()) return;
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
    const notify = () => {
      if (!current() || !editor) return;
      if (editor.error) log(editor.error, 'controls.failed');
      const confirmed = editor.confirmed;
      saver?.observe(confirmed, !editor.unsettled);
      setState(previous => ({ ...previous, assetId, status: previous?.status ?? 'ready',
        document: confirmed, settings: confirmed, desired: { ...editor!.desired }, pending: editor!.unsettled,
        editError: editor!.error, dirty: saver?.dirty || saver?.moving, saving: saver?.saving, saveError: saver?.error,
        history: saver?.history, historySteps: saver?.steps, historyOffset: saver?.historyOffset,
        historyLoading: saver?.historyLoading, historyError: saver?.historyError, canUndo: saver?.canUndo, canRedo: saver?.canRedo,
        movingHistory: saver?.moving,
        locked: frozen.current || saver?.locked, regenerating: restarting, regenerationError }));
      if (confirmed.mutationAttempts >= confirmed.regenerationThreshold && saver?.initialized && !saver.dirty && !saver.locked
        && !frozen.current && !regenerationError && !editor.error) void restart().catch(() => {});
    };
    const install = (settings: RawSettings) => {
      const installed = new RawControls(settings, { schedule: enqueue, changed: notify,
        hold: () => !!saver?.gesturing && installed.confirmed.mutationAttempts >= installed.confirmed.regenerationThreshold,
        preview: (confirmed, valid) => displayPreview(confirmed, () => current() && editor === installed && valid()),
      });
      editor = installed;
      saver = new RawRecipeSave(settings, { schedule: enqueue, changed: notify, controls: installed });
      saverRef.current = saver;
      editorRef.current = editor;
      notifyRef.current = notify;
      setState(previous => ({ ...previous, assetId, status: 'ready', document: settings, settings,
        desired: {}, pending: false, editError: undefined, dirty: true, saving: false, saveError: undefined, locked: true }));
      // Install runs on the owner queue; schedule initialization rather than awaiting it here.
      void saver.save().catch(() => {});
    };
    // Compose release/open on the existing owner queue, never a second lifecycle dispatcher.
    const owned = (action: () => Promise<void>) => new Promise<void>((resolve, reject) => {
      enqueue(async () => { try { await action(); resolve(); } catch (error) { reject(error); } });
    });
    const release = async () => {
      if (!workspace) return;
      try { await releaseRawWorkspace(workspace); }
      catch (cause) {
        if (!(cause instanceof RawApiError) || cause.code !== 'raw_workspace_conflict' || !await rawWorkspaceEmpty()) throw cause;
      }
      workspace = undefined;
    };
    const sessionEvent = (event: string) => {
      try { frontendLogger.add({ level: 'info', component: 'raw', event, context: {
        assetId, generation: editor!.confirmed.generation, revision: editor!.confirmed.revision,
        mutationAttempts: editor!.confirmed.mutationAttempts } }); } catch { /* Optional diagnostics. */ }
    };
    const restart = (retry = false): Promise<void> => {
      if (restartOperation) return restartOperation;
      if (!current() || !editor || !saver) return Promise.reject(new RawApiError('raw_document_closed'));
      sessionEvent('session.regenerationStarted');
      restarting = true;
      regenerationError = undefined;
      frozen.current = true;
      saver.pause();
      notify();
      restartOperation = Promise.resolve().then(async () => {
        if (stage === 'save') {
          if (retry && editor!.error) { editor!.retry(true); await owned(async () => {}); }
          await editor!.settle();
          if (!current()) throw new RawApiError('raw_document_closed');
          saver!.observe(editor!.confirmed, true);
          await saver!.save(retry, saver!.revision === 0);
          if (saver!.dirty || editor!.unsettled) throw new RawApiError('raw_save_unconfirmed');
          expectedFingerprint = editor!.confirmed.settingsFingerprint;
          expectedRecipeRevision = saver!.revision;
          oldGeneration = editor!.confirmed.generation;
          stage = 'release';
          editor!.dispose(); saver!.dispose();
        }
        await owned(async () => {
          if (!current()) throw new RawApiError('raw_document_closed');
          revoke();
          setState(previous => ({ ...previous!, status: 'loading', url: undefined }));
          await release();
          if (!current()) throw new RawApiError('raw_document_closed');
          stage = 'open';
          workspace = await createRawWorkspace();
          // A failed open may already have released its workspace; retry still verifies that fact.
          stage = 'release';
          if (!current()) throw new RawApiError('raw_document_closed');
          const doc = await openRawDocument(workspace, assetId);
          if (!current()) throw new RawApiError('raw_document_closed');
          const settings = await readRawSettings(doc);
          if (!current()) throw new RawApiError('raw_document_closed');
          if (settings.generation === oldGeneration || settings.settingsFingerprint !== expectedFingerprint
            || settings.recipeFingerprint !== expectedFingerprint || settings.recipeRevision !== expectedRecipeRevision)
            throw new RawApiError('raw_recipe_restore_mismatch');
          await displayPreview(settings);
          if (!current()) throw new RawApiError('raw_document_closed');
          install(settings);
          stage = 'save';
          frozen.current = false;
          sessionEvent('session.regenerationCompleted');
        });
      }).catch(cause => {
        if (current()) {
          regenerationError = cause instanceof RawApiError ? cause.code : 'raw_connection_failed';
          log(regenerationError, 'session.regenerationFailed');
          if (stage !== 'save') setState(previous => ({ ...previous!, status: 'error', url: undefined }));
        }
        throw cause;
      }).finally(() => {
        restarting = false;
        restartOperation = undefined;
        if (current()) {
          if (stage === 'save') notify();
          else setState(previous => ({ ...previous!, locked: true, regenerating: false, regenerationError }));
        }
      });
      return restartOperation;
    };
    renewalLockedRef.current = () => restarting || !!regenerationError;
    restartRef.current = restart;
    restartWaitRef.current = async () => {
      if (restartOperation) await restartOperation;
      if (regenerationError) throw new RawApiError(regenerationError);
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
        install(settings);
        const heartbeat = async () => {
          const attempt = editor!.serial, owner = editor;
          try { if (!restarting && !regenerationError && !editor!.unsettled && !editor!.error) await readRawDocument(editor!.confirmed, controller.signal); }
          catch (error) { if (!restarting && !regenerationError && owner === editor && attempt === editor!.serial) { fail(error); return; } }
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
      saver?.pause();
      // A late slider unmount cannot target a successor. Its old owner still finishes its
      // gesture on this same queue before cleanup, including transmitted native mutations.
      const finalSave = saver?.save();
      void finalSave?.catch(() => {});
      if (saverRef.current === saver) saverRef.current = null;
      if (editorRef.current === editor) editorRef.current = null;
      controller.abort();
      clearTimeout(timer);
      revoke();
      enqueue(async () => {
        if (saver?.dirty || saver?.error || editor?.unsettled) {
          log('raw_save_unconfirmed', 'recipe.saveFailed');
          return; // Never release an unconfirmed native document after an unexpected unmount.
        }
        editor?.dispose(); saver?.dispose();
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
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current() && (saver?.dirty || saver?.moving || editor?.unsettled)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('pagehide', pagehide); window.removeEventListener('beforeunload', beforeUnload); dispose(); };
  }, [assetId]);
  // A route change hides the old image before effect cleanup runs.
  const visible = assetId ? state?.assetId === assetId ? state : { assetId, status: 'loading' as const } : null;
  // A departing slider's commit callback must never flush the successor document's owner.
  const activeEditor = () => identity.current === assetId && editorRef.current?.confirmed.assetId === assetId ? editorRef.current : null;
  const callbackEditor = () => {
    const editor = activeEditor(), doc = visible?.document;
    return editor && doc?.generation === editor.confirmed.generation
      && doc.documentToken === editor.confirmed.documentToken ? editor : null;
  };
  const resume = () => {
    if (!activeEditor()) return;
    if (renewalLockedRef.current()) return;
    frozen.current = false;
    saverRef.current?.resume();
    notifyRef.current();
  };
  const prepareSave = async (retry = false) => {
    await restartWaitRef.current();
    const editor = activeEditor(), saver = saverRef.current;
    if (!editor || !saver) return; // No editable document has been exposed yet.
    frozen.current = true;
    saver.pause();
    notifyRef.current();
    await saver.waitHistory(retry);
    if (retry && (editor.error || saver.error === 'raw_revision_conflict')) {
      editor.retry(true);
      // Retry first resynchronizes on this queue; settle must not inspect its old error.
      await new Promise<void>(resolve => enqueue(async () => { resolve(); }));
    }
    do {
      await editor.settle();
      if (activeEditor() !== editor) throw new RawApiError('raw_stale_handle');
      saver.observe(editor.confirmed, true);
      await saver.save(retry);
      if (activeEditor() !== editor) throw new RawApiError('raw_stale_handle');
      // A control handoff accepted before freezing may start only after the first ack.
      // Drain it through the same queue before certifying departure.
    } while (saver.dirty || editor.unsettled);
  };
  const moveHistory = (action: 'undo' | 'redo' | 'jump', targetStepId?: string | null) => {
    if (!callbackEditor() || frozen.current) return;
    void saverRef.current?.move(action, targetStepId).catch(cause => log(cause instanceof RawApiError ? cause.code : 'raw_connection_failed', 'history.failed'));
  };
  return visible && { ...visible, undo: () => moveHistory('undo'), redo: () => moveHistory('redo'),
    jumpHistory: (stepId: string | null) => moveHistory('jump', stepId),
    loadMoreHistory: (retry = false, newer = false) => { if (callbackEditor() && !frozen.current) saverRef.current?.loadMoreHistory(retry, newer); },
    changeControls: (values: Partial<RawValues>) => {
      if (!frozen.current && callbackEditor()) for (const [control, value] of Object.entries(values))
        saverRef.current?.change(control as RawControlId, value!);
    },
    beginControls: (control: RawControlId) => { if (callbackEditor() && !frozen.current) saverRef.current?.begin(control); },
    flushControls: (control?: RawControlId) => { if (callbackEditor()) saverRef.current?.end(control); },
    retryRegeneration: () => { if (callbackEditor() && visible.regenerationError) void restartRef.current(true).catch(() => {}); }, retryControls: () => callbackEditor()?.retry(), prepareSave, resumeEditing: resume,
    retrySave: async () => { try { await prepareSave(true); } catch (cause) {
      const code = cause instanceof RawApiError ? cause.code : 'raw_connection_failed'; log(code, 'recipe.saveFailed');
    } finally { resume(); } } };
}
