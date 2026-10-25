import { useEffect, useRef, useState } from 'react';
import { createRawWorkspace, openRawDocument, rawCapability, rawPreview, cancelRawPreview, RawSuperseded, readRawDocument, readRawSettings,
  releaseRawWorkspace, rawWorkspaceEmpty, RawApiError, type RawDocument, type RawSettings, type RawValues, type RawControlId,
  type RawHistoryResult, type RawHistoryStep, type RawHistoryOperation, type RawFrame, type RawGeometry } from './rawApi';
import { frontendLogger } from './frontendLogging';
import { RawControls } from './rawControls';
import { RawRecipeSave } from './rawRecipeSave';
import { rawWholeSide, type RawView } from './rawWholePreview';
import { rawRegionOwner, rawRegion } from './rawApi';
import { RawRegionDelivery } from './rawRegionDelivery';
import { RawPreviewUrls, RawRegionOverlay, type RawWholeSurface } from './rawRegionOverlay';
import { requestManualRegion } from './rawRegionManual';
import { RawRegionAuto, REGION_AUTO_PROVISIONAL } from './rawRegionAuto';
import { createRawRegionDiagnosticsChannel, diagnosticVisibleRect, type RawRegionDiagnosticMessage,
  type RawRegionDiagnosticState, type RawRegionPosition } from './rawRegionDiagnostics';

type RawState = { assetId: string; status: 'loading' | 'ready' | 'unavailable' | 'error';
  url?: string; width?: number; height?: number; document?: RawDocument; code?: string; settings?: RawSettings;
  requestSide?: number; frame?: RawGeometry; quality?: 'draft' | 'full'; displayError?: string; imageRevision?: number;
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

async function decodeFrame(frame: RawFrame, signal: AbortSignal, urls: RawPreviewUrls) {
  const started = performance.now();
  const image = new Image();
  const url = urls.create(frame.blob);
  let removeAbort = () => {};
  try {
    image.src = url;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      const abort = () => reject(new RawApiError('raw_decode_cancelled'));
      bounded.addEventListener('abort', abort, { once: true });
      removeAbort = () => bounded.removeEventListener('abort', abort);
      if (bounded.aborted) abort();
    })]);
    if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new RawApiError('raw_invalid_response');
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'preview.decoded', context: {
      sequence: frame.sequence, quality: frame.quality ?? 'full', kind: frame.kind ?? 'after',
      decodeMs: performance.now() - started, width: frame.width, height: frame.height } }); } catch { /* Optional diagnostics. */ }
    return url;
  } catch (error) { urls.release(url); throw error; }
  finally { removeAbort(); image.removeAttribute('src'); }
}

export function useRawDocument(assetId: string | null, beforeRequested = false) {
  const [urls] = useState(() => new RawPreviewUrls());
  const wholeSurfaces = useRef<{ after?: RawWholeSurface; before?: RawWholeSurface }>({});
  const comparing = useRef(beforeRequested); comparing.current = beforeRequested;
  const overlayRef = useRef<RawRegionOverlay | null>(null);
  const [, regionChanged] = useState(0);
  const [regionOutline, setRegionOutline] = useState(false);
  const [state, setState] = useState<RawState | null>(null);
  const [before, setBefore] = useState<{ owner: string; key: string; status: 'loading' | 'ready' | 'error'; url?: string; width?: number; height?: number;
    quality?: 'draft' | 'full'; frame?: RawGeometry } | null>(null);
  const requestBeforeRef = useRef<(retry?: boolean) => void>(() => {});
  const beforeSerial = useRef(0);
  const serial = useRef(0);
  const identity = useRef(assetId);
  const editorRef = useRef<RawControls | null>(null);
  const saverRef = useRef<RawRecipeSave | null>(null);
  const frozen = useRef(false);
  const restartRef = useRef<(retry?: boolean) => Promise<void>>(async () => {});
  const restartWaitRef = useRef<() => Promise<void>>(async () => {});
  const renewalLockedRef = useRef<() => boolean>(() => false);
  const notifyRef = useRef<() => void>(() => {});
  const viewRef = useRef<(view?: RawView) => void>(() => {});
  const invalidateBeforeRef = useRef<() => void>(() => {});
  const resyncPreviewRef = useRef<() => void>(() => {});
  const suspendDisplayRef = useRef<() => void>(() => {});
  const regionRef = useRef<RawRegionDelivery | null>(null);
  const connectRegionRef = useRef<() => Promise<boolean>>(async () => false);
  const publishDiagnosticRef = useRef<() => void>(() => {});
  const evaluateAutoRef = useRef<() => void>(() => {});
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
    // Native geometry is available only after the first validated bitmap; never infer it from the PNG.
    let side = 1024, latestView: RawView | undefined;
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    let viewAggregationAt = 0;
    let displayGeneration = 0, viewGeneration = 0, displayRunning = false;
    let displayPending: { doc: RawDocument; valid: () => boolean; generation: number; quality: 'draft' | 'full'; geometryId: string | null; side: number } | undefined;
    let transmitted: { doc: RawDocument; serial: number } | undefined;
    let displayTargetKey: string | undefined;
    let revisionResyncs = 0;
    let displayedRevision = -1;
    let publishedFrame: { revision: number; quality: 'draft' | 'full'; frame: RawGeometry } | undefined;
    let regionOwner: Awaited<ReturnType<typeof rawRegionOwner>> | undefined;
    let regionConnection: Promise<boolean> | undefined;
    let auto: RawRegionAuto | undefined;
    let autoQueued = false;
    const evaluateAuto = () => {
      if (autoQueued || !current()) return;
      autoQueued = true;
      queueMicrotask(() => { autoQueued = false; if (current()) auto?.evaluate(); });
    };
    let diagnosticClientId: string | undefined, diagnosticPosition: RawRegionPosition | null = null;
    const diagnosticOwnerId = crypto.randomUUID();
    // Diagnostic pair selection must not mutate the darkroom's own Before/After preference.
    let diagnosticComparing: boolean | undefined;
    let diagnosticRequesting = false, diagnosticCleared = true, diagnosticErrorCode: string | undefined;
    let diagnosticOwnerErrorCode: string | undefined, diagnosticOwnerHttpStatus: number | undefined;
    let diagnosticPlanStart = 0;
    const diagnosticChannel = createRawRegionDiagnosticsChannel();
    const diagnosticSnapshot = (): RawRegionDiagnosticState => {
      const whole = wholeSurfaces.current.after, displayed = overlay?.display;
      const metadata = displayed?.after.metadata;
      const beforeReady = !!wholeSurfaces.current.before && wholeSurfaces.current.before.quality === 'full'
        && whole?.quality === 'full' && wholeSurfaces.current.before.frame.geometryId === whole.frame.geometryId
        && wholeSurfaces.current.before.doc.beforeKey === whole.doc.beforeKey;
      const geometryMatches = metadata && whole ? metadata.geometryId === whole.frame.geometryId : null;
      const state: RawRegionDiagnosticState = { connected: current(), supported: regionOwner?.supported ?? null,
        wholeQuality: whole?.quality ?? null, wholeGeometry: whole?.frame.geometryId ?? null,
        regionGeometry: metadata?.geometryId ?? null, geometryMatches, regionSize: metadata ? { width: metadata.width, height: metadata.height } : null,
        displayed: !!displayed && !!metadata && geometryMatches === true,
        beforeReady, comparing: diagnosticComparing ?? comparing.current, position: diagnosticPosition,
        requesting: diagnosticRequesting || !!auto?.report.active && (!!(region.state.running || region.state.pending)
          || !displayed && ['in_flight', 'native_preflight', 'render'].includes(auto.report.reason)),
        cleared: diagnosticCleared && !displayed, errorCode: diagnosticErrorCode,
        ownerErrorCode: diagnosticOwnerErrorCode, ownerHttpStatus: diagnosticOwnerHttpStatus,
        auto: auto?.report,
        frame: whole ? { nativeWidth: whole.frame.nativeWidth, nativeHeight: whole.frame.nativeHeight } : undefined,
        details: metadata ? { f: { fullWidth: metadata.fullWidth, fullHeight: metadata.fullHeight }, w: metadata.window, validRegion: metadata.validRegion,
          revision: metadata.documentRevision, viewGeneration: metadata.viewGeneration,
          planGeneration: displayed!.after.planGeneration, requestId: metadata.requestId } : null };
      return state;
    };
    const publishDiagnosticState = () => {
      if (!diagnosticClientId || !diagnosticChannel) return;
      try { diagnosticChannel.postMessage({ type: 'state', clientId: diagnosticClientId, ownerId: diagnosticOwnerId,
        state: diagnosticSnapshot() } satisfies RawRegionDiagnosticMessage); } catch { /* Diagnostics are best effort. */ }
    };
    publishDiagnosticRef.current = publishDiagnosticState;
    const region = new RawRegionDelivery({
      changed: () => { if (current()) { overlayRef.current?.refresh(); regionChanged(n => n + 1); evaluateAuto(); publishDiagnosticState(); } },
      owner: () => editor && publishedFrame && regionOwner ? {
        doc: editor.confirmed, ...regionOwner, geometry: publishedFrame.frame,
        blocked: !current() || frozen.current || editor.mutating || editor.unsettled && !editor.interacting || !!saver?.locked,
        wholeBusy: displayRunning || !!displayPending,
      } : undefined,
      send: async (owner, item, signal) => item.mode === 'region'
        ? rawRegion(owner.doc, item, owner.geometry, owner.supported, signal)
        : { operation: 'whole', frame: await rawPreview(owner.doc,
          item.identity.kind === 'before' ? ++beforeSerial.current : ++frameSerial, signal, item.identity.kind,
          { mode: 'whole', maxSide: item.maxSide, quality: item.quality, viewGeneration: item.viewGeneration,
            geometryId: owner.geometry.geometryId }) },
    });
    regionRef.current = region;
    const overlay = new RawRegionOverlay({ urls, current: candidate => region.isCurrent(candidate) && (auto?.accept(candidate) ?? true),
      context: () => ({ owner: region.owner, ...wholeSurfaces.current, comparing: diagnosticComparing ?? comparing.current,
        regionFull: auto?.enabled ? auto.full : undefined }),
      failed: code => { if (diagnosticClientId) { diagnosticRequesting = false; diagnosticErrorCode = code; publishDiagnosticState(); } },
      changed: () => { if (current()) {
        if (overlay.display && overlay.display.after.planGeneration > diagnosticPlanStart) diagnosticRequesting = false;
        regionChanged(n => n + 1); evaluateAuto(); publishDiagnosticState();
      } } });
    overlayRef.current = overlay;
    const unsubscribeRegion = region.subscribe((candidate, error) => {
      if (candidate) overlay.offer(candidate); else if (!error) overlay.clear();
      publishDiagnosticState();
    });
    // Capability is negotiated only for insufficient density or an explicit diagnostic connection.
    connectRegionRef.current = () => {
      if (regionConnection) return regionConnection;
      if (!editor || !current()) return Promise.resolve(false);
      const doc = editor.confirmed;
      const connection = rawRegionOwner(doc, controller.signal).then(value => {
        if (!current() || editor?.confirmed.documentToken !== doc.documentToken || editor.confirmed.generation !== doc.generation) return false;
        regionOwner = value;
        if (diagnosticClientId) {
          if (diagnosticErrorCode === 'raw_region_owner_failed') diagnosticErrorCode = undefined;
          diagnosticOwnerErrorCode = undefined; diagnosticOwnerHttpStatus = undefined;
        }
        regionChanged(n => n + 1); publishDiagnosticState(); return value.supported;
      }).catch(error => {
        if (!current() || editor?.confirmed.documentToken !== doc.documentToken || editor.confirmed.generation !== doc.generation) return false;
        if (diagnosticClientId) {
          diagnosticErrorCode = 'raw_region_owner_failed';
          diagnosticOwnerErrorCode = error instanceof RawApiError ? error.code : 'raw_connection_failed';
          diagnosticOwnerHttpStatus = error instanceof RawApiError ? error.status : undefined;
          publishDiagnosticState();
        }
        return false;
      }).finally(() => { if (regionConnection === connection) regionConnection = undefined; });
      regionConnection = connection;
      return regionConnection;
    };
    auto = new RawRegionAuto({ delivery: region, overlay,
      snapshot: () => ({ ...wholeSurfaces.current, comparing: diagnosticComparing ?? comparing.current,
        interacting: !!editor?.interacting || !!latestView?.interacting }),
      connect: () => connectRegionRef.current(), changed: publishDiagnosticState });
    evaluateAutoRef.current = evaluateAuto;
    let manualBusy = false;
    const manual = { request: async (input: Parameters<typeof requestManualRegion>[3]) => {
      if (manualBusy || !current()) return false;
      manualBusy = true;
      try {
        if (!await connectRegionRef.current() || !current()) return false;
        const whole = wholeSurfaces.current.after;
        if (!whole) return false;
        return await requestManualRegion(region, whole, wholeSurfaces.current.before, input);
      } finally { manualBusy = false; }
    }, clear: () => region.invalidate(), status: () => ({ owner: region.owner, state: region.state,
      frame: wholeSurfaces.current.after?.frame, wholeQuality: wholeSurfaces.current.after?.quality,
      beforeReady: !!wholeSurfaces.current.before,
      overlay: overlay.display ? { after: overlay.display.after.metadata, before: overlay.display.before?.metadata } : null }) };
    let debug = false;
    try { debug = localStorage.getItem('genzoroom-raw-region-debug') === '1'; } catch { /* Optional diagnostic entry point. */ }
    if (debug) window.genzoroomRegion = manual;
    const sendDiagnosticResult = (clientId: string, actionId: string, ok: boolean, errorCode?: string) => {
      try { diagnosticChannel?.postMessage({ type: 'result', clientId, ownerId: diagnosticOwnerId, actionId, ok, errorCode } satisfies RawRegionDiagnosticMessage); }
      catch { /* Diagnostics are best effort. */ }
    };
    const onDiagnosticMessage = (event: MessageEvent) => {
      const message = event.data as RawRegionDiagnosticMessage;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'attach' && typeof message.clientId === 'string') {
        diagnosticClientId = message.clientId;
        diagnosticErrorCode = undefined;
        void connectRegionRef.current().finally(publishDiagnosticState);
        publishDiagnosticState();
        return;
      }
      if (message.type === 'state.request' && message.clientId === diagnosticClientId) {
        void connectRegionRef.current().finally(publishDiagnosticState); publishDiagnosticState(); return;
      }
      if (message.type === 'detach' && message.clientId === diagnosticClientId) {
        diagnosticClientId = undefined; diagnosticRequesting = false; diagnosticErrorCode = undefined;
        diagnosticPosition = null; diagnosticComparing = undefined; diagnosticCleared = true;
        setRegionOutline(false); region.invalidate(); auto?.reset(); auto?.setEnabled(true); evaluateAuto(); publishDiagnosticState(); return;
      }
      if (message.type !== 'action' || message.clientId !== diagnosticClientId || message.ownerId !== diagnosticOwnerId) return;
      if (message.action === 'auto') {
        diagnosticComparing = undefined; auto?.setEnabled(message.enabled);
        publishDiagnosticState(); sendDiagnosticResult(message.clientId, message.actionId, true); return;
      }
      if (message.action === 'outline') { setRegionOutline(message.enabled); sendDiagnosticResult(message.clientId, message.actionId, true); return; }
      if (message.action === 'clear') {
        auto?.setEnabled(false);
        diagnosticRequesting = false; diagnosticCleared = true; diagnosticPosition = null; diagnosticErrorCode = undefined;
        region.invalidate(); publishDiagnosticState(); sendDiagnosticResult(message.clientId, message.actionId, true); return;
      }
      const whole = wholeSurfaces.current.after;
      if (!whole || whole.quality !== 'full') { diagnosticErrorCode = 'raw_region_whole_waiting';
        sendDiagnosticResult(message.clientId, message.actionId, false, diagnosticErrorCode); publishDiagnosticState(); return; }
      if (message.compare && (!wholeSurfaces.current.before || wholeSurfaces.current.before.quality !== 'full')) {
        diagnosticErrorCode = 'raw_region_pair_waiting';
        sendDiagnosticResult(message.clientId, message.actionId, false, diagnosticErrorCode); publishDiagnosticState(); return;
      }
      diagnosticPosition = message.position; diagnosticRequesting = true; diagnosticCleared = false; diagnosticErrorCode = undefined;
      auto?.setEnabled(false);
      diagnosticComparing = message.compare; overlay.refresh();
      diagnosticPlanStart = region.state.latestPlanGeneration;
      publishDiagnosticState();
      const { nativeWidth, nativeHeight } = whole.frame;
      void manual.request({ visible: diagnosticVisibleRect(message.position, nativeWidth, nativeHeight),
        context: 16, prefetch: 0, compare: message.compare }).then(ok => {
          if (!ok) throw new Error(regionOwner?.supported ? 'raw_region_whole_waiting' : 'raw_region_unavailable');
          publishDiagnosticState();
          sendDiagnosticResult(message.clientId, message.actionId, true);
        }).catch(error => {
          diagnosticRequesting = false; diagnosticErrorCode = error instanceof Error ? error.message : 'raw_connection_failed';
          publishDiagnosticState(); sendDiagnosticResult(message.clientId, message.actionId, false, diagnosticErrorCode);
        });
    };
    if (diagnosticChannel) diagnosticChannel.onmessage = onDiagnosticMessage;
    let restarting = false, regenerationError: string | undefined;
    let restartOperation: Promise<void> | undefined;
    let stage: 'save' | 'release' | 'open' = 'save';
    let expectedFingerprint: string | undefined, expectedRecipeRevision: number | undefined;
    let oldGeneration: number | undefined;
    const controller = new AbortController();
    const current = () => active && identity.current === assetId && serial.current === currentSerial;
    const revoke = () => {
      if (wholeSurfaces.current.after?.url === url) wholeSurfaces.current.after = undefined;
      if (url) urls.release(url); url = undefined;
    };
    const fail = (error: unknown) => {
      if (!current()) return;
      region.invalidate(); regionOwner = undefined;
      revoke();
      const code = error instanceof RawApiError ? error.code : 'raw_connection_failed';
      const unavailable = !available && (code === 'raw_unsupported' || code === 'raw_unavailable');
      if (!unavailable) log(code);
      setState({ assetId, status: unavailable ? 'unavailable' : 'error', code });
    };
    const invalidateDisplay = (preserveRegion = false) => {
      if (!preserveRegion) { region.invalidate(); auto?.reset(); }
      displayGeneration++;
      displayTargetKey = undefined;
      displayPending = undefined;
      if (current()) invalidateBeforeRef.current();
      if (transmitted) void cancelRawPreview(transmitted.doc, 'after', transmitted.serial).catch(() => {});
    };
    suspendDisplayRef.current = invalidateDisplay;
    const renderPreview = async (doc: RawDocument, quality: 'draft' | 'full', geometryId: string | null, maxSide: number, valid = current) => {
      if (!valid()) return;
      let candidate: string | undefined;
      const metrics = editor?.metrics, ackAt = metrics?.ackAt;
      const requestedView = viewGeneration;
      let adopted = false, discard: 'superseded' | 'failed' | undefined;
      if (quality === 'draft' && metrics) metrics.draftRequests++;
      try {
        if (frameSerial >= 2 ** 31 - 2) { void restart().catch(() => {}); return; }
        const requestSerial = ++frameSerial;
        transmitted = { doc, serial: requestSerial };
        const frame = await rawPreview(doc, requestSerial, controller.signal, 'after', {
          quality, mode: 'whole', maxSide, geometryId, viewGeneration });
        if (!valid()) return;
        candidate = await decodeFrame(frame, controller.signal, urls);
        if (!valid()) return;
        if (doc.revision < displayedRevision) return;
        // Recheck engine identity after decode, before publishing a native result.
        await readRawDocument(doc, controller.signal);
        if (!valid()) return;
        revoke();
        displayedRevision = doc.revision;
        url = candidate;
        candidate = undefined;
        if (frame.frame) publishedFrame = { revision: doc.revision, quality: frame.quality ?? quality, frame: frame.frame };
        wholeSurfaces.current.after = frame.frame ? { url, doc: { ...doc }, frame: frame.frame, quality: frame.quality ?? quality } : undefined;
        const baseline = wholeSurfaces.current.before;
        if (baseline && frame.frame && baseline.doc.assetId === doc.assetId && baseline.doc.handle === doc.handle
          && baseline.doc.generation === doc.generation && baseline.doc.documentToken === doc.documentToken
          && baseline.doc.beforeKey === doc.beforeKey && baseline.frame.geometryId === frame.frame.geometryId
          && baseline.quality === (frame.quality ?? quality)) {
          // B1's Before bitmap is content-keyed: rebind only its receipt revision after the same baseline/geometry is confirmed.
          wholeSurfaces.current.before = { ...baseline, doc: { ...doc } };
        }
        overlay.refresh();
        publishDiagnosticState();
        setState(previous => ({ ...previous, assetId, status: 'ready', url, width: frame.width, height: frame.height,
          requestSide: maxSide, frame: frame.frame, quality: frame.quality ?? quality, imageRevision: doc.revision, displayError: undefined }));
        adopted = true;
        if (metrics) {
          if (quality === 'draft') {
            metrics.draftAdoptions++;
            metrics.ackDisplayMaxMs = Math.max(metrics.ackDisplayMaxMs, performance.now() - (ackAt ?? performance.now()));
          } else if (metrics.endedAt) { metrics.fullDisplayMs = performance.now() - metrics.endedAt; metrics.report('fullDisplayed'); }
        }
        revisionResyncs = 0;
      } catch (cause) {
        discard = cause instanceof RawSuperseded ? 'superseded' : 'failed';
        throw cause;
      } finally {
        if (!adopted && metrics && quality === 'draft') {
          const reason = !current() || !editor ? 'departure'
            : editor.confirmed.generation !== doc.generation ? 'generation'
            : editor.confirmed.documentToken !== doc.documentToken ? 'session'
            : requestedView !== viewGeneration ? 'view'
            : frozen.current ? 'frozen' : !editor.interacting ? 'ended'
            : editor.mutating || editor.confirmed.revision !== doc.revision ? 'revision' : discard ?? 'superseded';
          metrics.discards[reason]++;
        }
        if (candidate) urls.release(candidate);
      }
    };
    const pumpDisplay = () => {
      if (displayRunning || !displayPending || !current() || frozen.current) return;
      if (displayPending.quality === 'full' && saver?.locked) return;
      const intent = displayPending;
      displayPending = undefined;
      const valid = () => current() && intent.valid() && intent.generation === displayGeneration;
      if (!valid()) return;
      displayRunning = true;
      // This slot owns failures and URL cleanup; mutation/save queues never join image work.
      void renderPreview(intent.doc, intent.quality, intent.geometryId, intent.side, valid).catch(cause => {
        if (!valid()) return;
        if (cause instanceof RawSuperseded) {
          if (cause.reason === 'revision') resyncPreview(valid);
          return;
        }
        const code = cause instanceof RawApiError ? cause.code : 'raw_connection_failed';
        log(code);
        displayTargetKey = undefined;
        setState(previous => previous && ({ ...previous, displayError: code }));
      }).finally(() => { transmitted = undefined; displayRunning = false; pumpDisplay(); region.refresh(); evaluateAuto(); publishDiagnosticState(); });
    };
    const resyncPreview = (valid = current) => {
      if (!valid()) return;
      if (revisionResyncs++ > 0) {
        setState(previous => previous && ({ ...previous, displayError: 'raw_preview_geometry_unavailable' }));
        return;
      }
      enqueue(async () => {
        if (!valid() || !editor || editor.unsettled) return;
        try {
          editor.confirmed = await readRawSettings(editor.confirmed);
          notify();
          displayPreview(editor.confirmed);
        } catch {
          if (valid()) setState(previous => previous && ({ ...previous, displayError: 'raw_preview_geometry_unavailable' }));
        }
      });
    };
    resyncPreviewRef.current = () => resyncPreview();
    const displayPreview = (doc: RawDocument, valid = current) => {
      if (!current() || !valid()) return;
      if (editor && !editor.interacting && (Object.keys(editor.desired).length || Object.keys(editor.pending).length)) return;
      // A gesture keeps its selected size; the final Full re-evaluates the latest view.
      if (!editor?.interacting && !latestView?.interacting && latestView) side = rawWholeSide(latestView, side) ?? side;
      const quality = editor?.interacting || latestView?.interacting ? 'draft' : 'full';
      const key = `${doc.documentToken}:${doc.revision}:${quality}:${side}:${viewGeneration}`;
      if (key === displayTargetKey) return;
      // New ACKs replace the pending slot, not a running ACK image merely because
      // desired changed. Native revision and ownership checks still gate adoption.
      if (quality === 'full') invalidateDisplay(publishedFrame?.revision === doc.revision);
      displayTargetKey = key;
      const geometryId = publishedFrame?.revision === doc.revision && publishedFrame.quality === quality
        ? publishedFrame.frame.geometryId : null;
      const owner = editor, view = viewGeneration;
      const acknowledged = () => valid() && editor === owner && !editor?.mutating && view === viewGeneration
        && editor?.confirmed.generation === doc.generation && editor.confirmed.documentToken === doc.documentToken
        && editor.confirmed.revision === doc.revision;
      displayPending = { doc, valid: acknowledged, generation: displayGeneration, quality, geometryId, side };
      pumpDisplay();
      region.refresh();
      overlay.refresh();
    };
    const applyView = () => {
      viewTimer = undefined;
      try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'region.aggregation', context: {
        aggregationWaitMs: performance.now() - viewAggregationAt,
      } }); } catch { /* Observe the existing timer; never add or extend a scheduling slot. */ }
      if (!current() || frozen.current || !editor || !latestView || editor.interacting || editor.unsettled) return;
      const next = latestView.interacting ? side : rawWholeSide(latestView, side);
      if (next !== undefined && next !== side) {
        side = next; viewGeneration++; revisionResyncs = 0;
        invalidateDisplay();
      }
      displayPreview(editor.confirmed); evaluateAuto();
    };
    viewRef.current = (view) => {
      if (view) {
        latestView = view;
        auto?.viewChanged(view);
        // One non-extending B1/C2-C aggregation slot samples the latest view during a continuous Pan.
        if (!viewTimer) {
          viewAggregationAt = performance.now();
          viewTimer = setTimeout(applyView, REGION_AUTO_PROVISIONAL.aggregationMs);
        }
        return;
      }
      if (!current() || !editor) return;
      viewGeneration++;
      revisionResyncs = 0;
      invalidateDisplay();
      if (editor.unsettled) return;
      displayPreview(editor.confirmed);
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
      pumpDisplay();
      region.refresh();
      overlay.refresh();
      evaluateAuto();
    };
    const install = (settings: RawSettings) => {
      region.resetDocument(); auto?.reset(); regionOwner = undefined; regionConnection = undefined;
      wholeSurfaces.current = {};
      frameSerial = 0;
      displayedRevision = -1;
      viewGeneration = 0;
      publishedFrame = undefined;
      const installed = new RawControls(settings, { schedule: enqueue, changed: notify,
        hold: () => !!saver?.gesturing && installed.confirmed.mutationAttempts >= installed.confirmed.regenerationThreshold,
        previewBusy: () => displayRunning || !!displayPending || !!region.state.running || !!region.state.pending,
        preview: (confirmed, valid) => displayPreview(confirmed, () => current() && editor === installed && valid()),
        invalidate: invalidateDisplay,
      });
      editor = installed;
      saver = new RawRecipeSave(settings, { schedule: enqueue, changed: notify, controls: installed });
      saverRef.current = saver;
      editorRef.current = editor;
      notifyRef.current = notify;
      setState(previous => ({ ...previous, assetId, status: 'ready', document: settings, settings,
        desired: {}, pending: false, editError: undefined, dirty: true, saving: false, saveError: undefined, locked: true }));
      // Install runs on the owner queue; schedule initialization rather than awaiting it here.
      void saver.save().then(() => { if (current()) displayPreview(installed.confirmed); }).catch(() => {});
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
      invalidateDisplay();
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
        install(settings);
        if (diagnosticClientId) void connectRegionRef.current().finally(publishDiagnosticState);
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
      auto?.dispose(); evaluateAutoRef.current = () => {};
      region.dispose();
      unsubscribeRegion(); overlay.dispose();
      if (window.genzoroomRegion === manual) delete window.genzoroomRegion;
      try { diagnosticChannel?.close(); } catch { /* Best-effort diagnostic channel cleanup. */ }
      if (diagnosticChannel) diagnosticChannel.onmessage = null;
      if (publishDiagnosticRef.current === publishDiagnosticState) publishDiagnosticRef.current = () => {};
      setRegionOutline(false);
      if (overlayRef.current === overlay) overlayRef.current = null;
      wholeSurfaces.current = {};
      if (regionRef.current === region) regionRef.current = null;
      invalidateDisplay();
      saver?.pause();
      // A late slider unmount cannot target a successor. Its old owner still finishes its
      // gesture on this same queue before cleanup, including transmitted native mutations.
      const finalSave = saver?.save();
      void finalSave?.catch(() => {});
      if (saverRef.current === saver) saverRef.current = null;
      if (editorRef.current === editor) editorRef.current = null;
      controller.abort();
      clearTimeout(timer); clearTimeout(viewTimer);
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
  // A comparison toggle and ordinary After revisions do not own the native Before cache lifetime.
  const beforeKey = state?.assetId === assetId ? state.document?.beforeKey : null;
  const generation = state?.document?.generation, token = state?.document?.documentToken;
  useEffect(() => { beforeSerial.current = 0; }, [generation, token]);
  const afterQuality = state?.quality ?? 'full', afterGeometry = state?.frame?.geometryId, afterSide = state?.requestSide ?? 1024;
  const beforeOwner = `${assetId}:${generation}:${token}:${beforeKey}:${afterQuality}:${afterGeometry}:${afterSide}`;
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined, operation = false, failed = false;
    let transmitted: { doc: RawDocument; serial: number } | undefined;
    let intentGeneration = 0;
    invalidateBeforeRef.current = () => {
      intentGeneration++;
      if (transmitted) void cancelRawPreview(transmitted.doc, 'before', transmitted.serial).catch(() => {});
    };
    const valid = () => !controller.signal.aborted && identity.current === assetId && !frozen.current
      && editorRef.current?.confirmed.beforeKey === beforeKey
      && editorRef.current?.confirmed.generation === generation && editorRef.current?.confirmed.documentToken === token;
    requestBeforeRef.current = (retry = false) => {
      const editor = editorRef.current;
      if (!beforeKey || !editor || !valid() || operation || url && !retry || failed && !retry || editor.unsettled || saverRef.current?.locked) return;
      if (url) {
        if (wholeSurfaces.current.before?.url === url) wholeSurfaces.current.before = undefined;
        urls.release(url); url = undefined;
      }
      operation = true; failed = false;
      const attempt = intentGeneration;
      const currentIntent = () => valid() && attempt === intentGeneration;
      setBefore({ owner: beforeOwner, key: beforeKey, status: 'loading' });
      void (async () => {
        let candidate: string | undefined;
        try {
          const requestSerial = ++beforeSerial.current;
          if (requestSerial >= 2 ** 31 - 2) { void restartRef.current().catch(() => {}); return; }
          transmitted = { doc: editor.confirmed, serial: requestSerial };
          const frame = await rawPreview(editor.confirmed, requestSerial, controller.signal, 'before', {
            quality: afterQuality, mode: 'whole', maxSide: afterSide, geometryId: null, viewGeneration: 0 });
          if (!currentIntent()) return;
          if (frame.kind !== 'before' || frame.key !== beforeKey) throw new RawApiError('raw_invalid_response');
          candidate = await decodeFrame(frame, controller.signal, urls);
          if (!currentIntent()) return;
          url = candidate; candidate = undefined;
          wholeSurfaces.current.before = frame.frame ? { url, doc: { ...transmitted!.doc }, frame: frame.frame,
            quality: frame.quality ?? afterQuality } : undefined;
          overlayRef.current?.refresh();
          publishDiagnosticRef.current();
          evaluateAutoRef.current();
          setBefore({ owner: beforeOwner, key: beforeKey, status: 'ready', url, width: frame.width, height: frame.height,
            frame: frame.frame, quality: frame.quality ?? afterQuality });
        } catch (cause) {
          if (!currentIntent()) return;
          if (cause instanceof RawSuperseded) {
            if (cause.reason === 'revision') resyncPreviewRef.current();
            return;
          }
          failed = true;
          setBefore({ owner: beforeOwner, key: beforeKey, status: 'error' });
          try { frontendLogger.add({ level: 'warn', component: 'raw', event: 'before.failed', context: {
            errorCode: cause instanceof RawApiError ? cause.code : 'raw_connection_failed', generation: generation ?? null } }); } catch { /* Optional diagnostics. */ }
        } finally { operation = false; transmitted = undefined; if (candidate) urls.release(candidate); }
      })();
    };
    return () => {
      if (transmitted) void cancelRawPreview(transmitted.doc, 'before', transmitted.serial).catch(() => {});
      controller.abort(); if (url) urls.release(url);
      if (wholeSurfaces.current.before?.url === url) wholeSurfaces.current.before = undefined;
    };
  }, [assetId, generation, token, beforeKey, beforeOwner, afterQuality]);
  useEffect(() => {
    if (beforeRequested && state?.status === 'ready' && !state.pending && !state.locked) requestBeforeRef.current();
  }, [beforeRequested, beforeKey, beforeOwner, state?.status, state?.pending, state?.locked, state?.imageRevision]);
  const wasComparing = useRef(beforeRequested);
  useEffect(() => {
    if (wasComparing.current && !beforeRequested) overlayRef.current?.clear();
    else overlayRef.current?.refresh();
    wasComparing.current = beforeRequested;
    evaluateAutoRef.current();
  }, [beforeRequested]);

  // Hide old ownership synchronously, before passive effects revoke its URLs.
  const visible = assetId ? state?.assetId === assetId ? state : { assetId, status: 'loading' as const } : null;
  const beforeMatches = before?.owner === beforeOwner && before?.key === beforeKey;
  const beforeSizeMatches = beforeMatches && !visible?.pending && visible?.imageRevision === visible?.document?.revision
    && before?.width === visible?.width && before?.height === visible?.height
    && before?.quality === visible?.quality && (visible?.frame
      ? before?.frame?.geometryId === visible.frame.geometryId && before.frame.nativeWidth === visible.frame.nativeWidth
        && before.frame.nativeHeight === visible.frame.nativeHeight
      : !before?.frame && before?.width === visible?.width && before?.height === visible?.height);
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
    activeEditor()?.refreshPreview();
    notifyRef.current();
  };
  const prepareSave = async (retry = false) => {
    await restartWaitRef.current();
    const editor = activeEditor(), saver = saverRef.current;
    if (!editor || !saver) return; // No editable document has been exposed yet.
    frozen.current = true;
    suspendDisplayRef.current();
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
  return visible && { ...visible, beforeAvailable: !!beforeKey,
    regionDelivery: regionRef.current,
    regionDisplay: overlayRef.current?.display,
    regionOutline,
    connectRegion: () => connectRegionRef.current(),
    viewChanged: (view?: RawView) => {
      if (callbackEditor() && (!view || !visible.frame || view.geometryId === visible.frame.geometryId)) viewRef.current(view);
    },
    retryPreview: () => { if (callbackEditor() && !frozen.current) viewRef.current(); },
    beforeUrl: beforeMatches && beforeSizeMatches ? before?.url : undefined,
    beforeStatus: beforeMatches ? before?.status === 'ready' && !beforeSizeMatches ? 'error' as const : before?.status : undefined,
    retryBefore: () => requestBeforeRef.current(true),
    undo: () => moveHistory('undo'), redo: () => moveHistory('redo'),
    operate: (operation: RawHistoryOperation) => {
      if (callbackEditor() && !frozen.current) void saverRef.current?.operate(operation).catch(cause =>
        log(cause instanceof RawApiError ? cause.code : 'raw_connection_failed', 'history.failed'));
    },
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
