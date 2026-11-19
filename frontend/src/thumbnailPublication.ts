import { useCallback, useSyncExternalStore } from 'react';
import { frontendLogger } from './frontendLogging';
import { fetchThumbnailPublications, isThumbnailPublicationState, type ThumbnailPublication } from './thumbnailPublicationApi';

const listeners = new Map<string, Set<() => void>>();
const snapshots = new Map<string, ThumbnailPublication>();
const pendingIds = new Set<string>();
let eventSource: EventSource | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconciliationRunning = false;
let streamGeneration = 0;
let backendGenerationId: string | null = null;
let lastSequence = -1;

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
  for (const assetId of assetIds) pendingIds.add(assetId);
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
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
  const controller = new AbortController();
  try {
    for (let offset = 0; offset < assetIds.length; offset += 1000) {
      let result;
      try {
        const chunk = assetIds.slice(offset, offset + 1000);
        result = await fetchThumbnailPublications(chunk, controller.signal);
        if (expectedStreamGeneration !== streamGeneration) return;
        if (backendGenerationId !== result.generationId) {
          backendGenerationId = result.generationId;
          lastSequence = -1;
        }
        if (result.sequence < lastSequence) continue;
        lastSequence = result.sequence;
        for (const [assetId, publication] of Object.entries(result.items)) publishSnapshot(assetId, publication);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) logSyncFailure(error);
        return;
      }
    }
  } finally {
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
    backendGenerationId = message.generationId;
    lastSequence = -1;
    scheduleReconciliation();
  }
  const sequence = message.sequence as number;
  if (sequence <= lastSequence) return;
  const missedEvents = lastSequence >= 0 && sequence > lastSequence + 1;
  lastSequence = sequence;
  if (missedEvents) scheduleReconciliation();
  if (message.type === 'resync') { scheduleReconciliation(); return; }
  if (typeof message.assetId !== 'string' || !isThumbnailPublicationState(message.state)
    || !(message.publicationVersion === null || typeof message.publicationVersion === 'string'
      && /^\d{1,24}$/.test(message.publicationVersion))) {
    scheduleReconciliation(); return;
  }
  const previous = snapshots.get(message.assetId);
  publishSnapshot(message.assetId, {
    recipeRevision: previous?.recipeRevision ?? null,
    state: message.state,
    publicationVersion: message.publicationVersion,
  });
}

function ensureEventSource() {
  if (eventSource || typeof EventSource === 'undefined') return;
  try {
    const source = new EventSource('/api/thumbnail-publications/events');
    eventSource = source;
    source.addEventListener('open', () => {
      streamGeneration += 1;
      scheduleReconciliation();
    });
    source.addEventListener('publication', event => onPublication(event as MessageEvent<string>));
    source.addEventListener('resync', event => onPublication(event as MessageEvent<string>));
    source.onerror = () => {
      // EventSource owns reconnect timing; every successful reopen triggers a status resync.
    };
  } catch (error) {
    logSyncFailure(error);
  }
}

export function subscribeThumbnailPublication(assetId: string, listener: () => void): () => void {
  let assetListeners = listeners.get(assetId);
  if (!assetListeners) { assetListeners = new Set(); listeners.set(assetId, assetListeners); }
  assetListeners.add(listener);
  ensureEventSource();
  if (eventSource) scheduleReconciliation([assetId]);
  return () => {
    const current = listeners.get(assetId);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(assetId);
  };
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
