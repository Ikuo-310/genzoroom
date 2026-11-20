import { useCallback, useSyncExternalStore } from 'react';
import { frontendLogger } from './frontendLogging';
import { fetchThumbnailPublications, isThumbnailPublicationState, type ThumbnailPublication } from './thumbnailPublicationApi';

const listeners = new Map<string, Set<() => void>>();
const snapshots = new Map<string, ThumbnailPublication>();
const pendingIds = new Set<string>();
let eventSource: EventSource | null = null;
let streamListeners: AbortController | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconciliationRunning = false;
let streamGeneration = 0;
let backendGenerationId: string | null = null;
let lastSequence = -1;
const assetSequences = new Map<string, number>();
const retries = new Map<string, number>();
const retryIds = new Set<string>();
let controller: AbortController | null = null;
let activeChunk: string[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const RECONCILIATION_TIMEOUT_MS = 15_000;

function resetSynchronization() {
  streamGeneration += 1;
  controller?.abort();
  lastSequence = -1;
  backendGenerationId = null;
  assetSequences.clear();
  retries.clear();
  retryIds.clear();
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

function queueRetry(ids: string[]) {
  for (const id of ids) {
    if (!listeners.has(id)) continue;
    const count = Math.min(4, (retries.get(id) ?? 0) + 1);
    retries.set(id, count);
    if (count <= 3) retryIds.add(id);
  }
  if (retryTimer !== null || !retryIds.size) return;
  let delay = 500;
  for (const id of retryIds) delay = Math.max(delay, 500 * 2 ** ((retries.get(id) ?? 1) - 1));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const queued = [...retryIds];
    retryIds.clear();
    scheduleReconciliation(queued);
  }, delay);
}

function logSyncFailure(error: unknown) {
  try {
    frontendLogger.add({ level: 'warn', component: 'thumbnail_publication', event: 'sync.failed',
      context: { errorCode: error instanceof Error ? error.message : 'request_failed' } });
  } catch { /* Publication synchronization must not change image rendering. */ }
}

function publishSnapshot(assetId: string, next: ThumbnailPublication) {
  const previous = snapshots.get(assetId);
  if (previous && previous.recipeRevision === next.recipeRevision && previous.state === next.state
    && previous.publicationVersion === next.publicationVersion) return;
  snapshots.set(assetId, next);
  for (const listener of listeners.get(assetId) ?? []) listener();
}

function activeAssetIds() { return [...listeners.keys()]; }

function scheduleReconciliation(assetIds: Iterable<string> = activeAssetIds()) {
  for (const assetId of assetIds) if (listeners.has(assetId)) pendingIds.add(assetId);
  if (reconcileTimer !== null || !pendingIds.size) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile([...pendingIds]);
  }, 25);
}

async function reconcile(assetIds: string[]) {
  if (!assetIds.length || !eventSource) return;
  if (reconciliationRunning) {
    for (const assetId of assetIds) pendingIds.add(assetId);
    return;
  }
  reconciliationRunning = true;
  pendingIds.clear();
  const expectedStreamGeneration = streamGeneration;
  const request = new AbortController();
  controller = request;
  try {
    for (let offset = 0; offset < assetIds.length; offset += 1000) {
      const chunk = assetIds.slice(offset, offset + 1000).filter(id => listeners.has(id));
      if (!chunk.length) continue;
      activeChunk = chunk;
      const owners = chunk.map(id => listeners.get(id));
      const batchController = new AbortController();
      let timedOut = false;
      const abortForStreamChange = () => batchController.abort();
      if (request.signal.aborted) batchController.abort();
      else request.signal.addEventListener('abort', abortForStreamChange, { once: true });
      let abortRequest: (() => void) | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          batchController.abort();
          reject(new Error('thumbnail_publication_request_timeout'));
        }, RECONCILIATION_TIMEOUT_MS);
      });
      const cancelled = new Promise<never>((_, reject) => {
        abortRequest = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abortRequest();
        else request.signal.addEventListener('abort', abortRequest, { once: true });
      });
      try {
        // Some fetch implementations do not settle promptly after abort; the race enforces the deadline.
        const result = await Promise.race([
          fetchThumbnailPublications(chunk, batchController.signal), deadline, cancelled,
        ]);
        if (expectedStreamGeneration !== streamGeneration || request.signal.aborted) return;
        if (backendGenerationId !== null && backendGenerationId !== result.generationId) {
          queueRetry(chunk);
          continue;
        }
        backendGenerationId = result.generationId;
        // A snapshot covers only its requested Assets, never the whole SSE stream.
        for (const [index, id] of chunk.entries()) {
          if (listeners.get(id) !== owners[index]) continue;
          const publication = result.items[id];
          if (!publication) { queueRetry([id]); continue; }
          retries.delete(id);
          retryIds.delete(id);
          if (result.sequence < (assetSequences.get(id) ?? -1)) continue;
          assetSequences.set(id, result.sequence);
          publishSnapshot(id, publication);
        }
      } catch (error) {
        if (request.signal.aborted) return;
        logSyncFailure(timedOut ? new Error('thumbnail_publication_request_timeout') : error);
        queueRetry(chunk);
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        if (abortRequest) request.signal.removeEventListener('abort', abortRequest);
        request.signal.removeEventListener('abort', abortForStreamChange);
      }
    }
  } finally {
    activeChunk = [];
    controller = null;
    reconciliationRunning = false;
    if (pendingIds.size) scheduleReconciliation([]);
  }
}

function onPublication(event: MessageEvent<string>) {
  let value: unknown;
  try { value = JSON.parse(event.data); } catch { scheduleReconciliation(); return; }
  if (!value || typeof value !== 'object') { scheduleReconciliation(); return; }
  const message = value as Record<string, unknown>;
  if (typeof message.generationId !== 'string' || !Number.isSafeInteger(message.sequence)) {
    scheduleReconciliation(); return;
  }
  if (message.generationId !== backendGenerationId) {
    resetSynchronization();
    backendGenerationId = message.generationId;
    scheduleReconciliation();
  }
  const sequence = message.sequence as number;
  if (sequence <= lastSequence) return;
  const missedEvents = lastSequence >= 0 && sequence > lastSequence + 1;
  lastSequence = sequence;
  if (missedEvents) scheduleReconciliation();
  if (message.type === 'resync') { scheduleReconciliation(); return; }
  const hasPublicationVersion = Object.prototype.hasOwnProperty.call(message, 'publicationVersion');
  if (typeof message.assetId !== 'string' || !isThumbnailPublicationState(message.state)
    || (hasPublicationVersion && !(message.publicationVersion === null || typeof message.publicationVersion === 'string'
      && /^[0-9a-f]{32}$/.test(message.publicationVersion)))) {
    scheduleReconciliation(); return;
  }
  if (!listeners.has(message.assetId) || sequence <= (assetSequences.get(message.assetId) ?? -1)) return;
  assetSequences.set(message.assetId, sequence);
  const previous = snapshots.get(message.assetId);
  if (!hasPublicationVersion && previous === undefined) {
    // State-only events cannot establish which image URL is safe until a snapshot arrives.
    scheduleReconciliation([message.assetId]);
    return;
  }
  publishSnapshot(message.assetId, {
    recipeRevision: previous?.recipeRevision ?? null,
    state: message.state,
    publicationVersion: hasPublicationVersion ? message.publicationVersion as string | null
      : previous?.publicationVersion ?? null,
  });
}

function ensureEventSource() {
  if (shuttingDown || eventSource || typeof EventSource === 'undefined') return;
  try {
    const source = new EventSource('/api/thumbnail-publications/events');
    eventSource = source;
    streamListeners = new AbortController();
    const options = { signal: streamListeners.signal };
    source.addEventListener('open', () => {
      if (eventSource !== source) return;
      resetSynchronization();
      scheduleReconciliation();
    }, options);
    const receive = (event: Event) => {
      if (eventSource === source) onPublication(event as MessageEvent<string>);
    };
    source.addEventListener('publication', receive, options);
    source.addEventListener('resync', receive, options);
  } catch (error) {
    logSyncFailure(error);
  }
}

export function subscribeThumbnailPublication(assetId: string, listener: () => void): () => void {
  let assetListeners = listeners.get(assetId);
  if (!assetListeners) { assetListeners = new Set(); listeners.set(assetId, assetListeners); }
  assetListeners.add(listener);
  if (shuttingDown) return () => unsubscribeThumbnailPublication(assetId, listener);
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  ensureEventSource();
  if (eventSource) scheduleReconciliation([assetId]);
  return () => {
    unsubscribeThumbnailPublication(assetId, listener);
  };
}

function unsubscribeThumbnailPublication(assetId: string, listener: () => void) {
  const current = listeners.get(assetId);
  current?.delete(listener);
  if (current?.size !== 0) return;
  listeners.delete(assetId);
  snapshots.delete(assetId);
  assetSequences.delete(assetId);
  pendingIds.delete(assetId);
  retries.delete(assetId);
  retryIds.delete(assetId);
  if (activeChunk.length && !activeChunk.some(id => listeners.has(id))) {
    controller?.abort();
    // The request owns the remaining batches too, so preserve their pending work.
    scheduleReconciliation();
  }
  if (listeners.size || shuttingDown) return;
  resetSynchronization();
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  // Keep the transport across route transitions without retaining Asset state.
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const source = eventSource;
    eventSource = null;
    streamListeners?.abort();
    streamListeners = null;
    source?.close();
  }, 1000);
}

export function closeThumbnailPublicationStream() {
  if (shuttingDown) return;
  shuttingDown = true;
  controller?.abort();
  controller = null;
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  pendingIds.clear();
  retryIds.clear();
  retries.clear();
  streamListeners?.abort();
  streamListeners = null;
  eventSource?.close();
  eventSource = null;
  activeChunk = [];
}

export function resumeThumbnailPublicationStream() {
  if (!shuttingDown) return;
  shuttingDown = false;
  if (!listeners.size) return;
  ensureEventSource();
  scheduleReconciliation();
}

export function refreshThumbnailPublication(assetId: string) {
  retries.delete(assetId);
  scheduleReconciliation([assetId]);
}

export function getThumbnailPublication(assetId: string): ThumbnailPublication | undefined {
  return snapshots.get(assetId);
}

export function useThumbnailPublication(assetId: string, enabled: boolean): ThumbnailPublication | undefined {
  const subscribe = useCallback((listener: () => void) => enabled
    ? subscribeThumbnailPublication(assetId, listener) : () => {}, [assetId, enabled]);
  const getSnapshot = useCallback(() => enabled ? getThumbnailPublication(assetId) : undefined, [assetId, enabled]);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
