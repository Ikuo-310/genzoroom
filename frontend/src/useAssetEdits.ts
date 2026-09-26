import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPACT_HISTORY_ON_EXIT,
  compactEditStateSnapshot,
  compactEditSession,
  createEditStateSnapshot,
  restoreEditSession,
  validateEditStateSnapshot,
  type EditSourceIdentity,
  type EditStateSnapshot,
} from './editState';
import { createEditStateSaveId, EditStateApiError, getAssetEditState, putAssetEditState } from './editStateApi';
import { editSession, newSession, type EditAction, type EditSession } from './editing';
import { isNativeEditingTarget, undoShortcut } from './editShortcuts';

type LoadStatus = 'unloaded' | 'loading' | 'ready' | 'error';
type SaveStatus = 'idle' | 'saving';
type RetrySave = {
  fingerprint: string;
  expectedRevision: number;
  saveId: string;
  snapshot: EditStateSnapshot;
  syncSession: boolean;
  liveFingerprint: string | null;
  liveSession: EditSession;
};
type AutosaveTimer = { timeout: number; generation: number };
type LoadOperation = { controller: AbortController; generation: number; timeout: number; promise: Promise<void> };
type AssetEditRecord = {
  session: EditSession;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  revision: number;
  updatedAt?: string;
  lastSaveId?: string;
  sourceIdentity: EditSourceIdentity;
  savedFingerprint: string | null;
  retrySave?: RetrySave;
  autosaveError?: EditStateApiError['kind'] | null;
  autosaveErrorGeneration?: number;
  loadError?: EditStateApiError['kind'];
  editedThisSession: boolean;
  needsCompaction: boolean;
  organizationUndo?: EditSession;
};

export type SaveResult = { ok: true; clean: boolean } | { ok: false; error: EditStateApiError };
export type ExitSaveResult =
  | { ok: true; compactFallbackAssetIds: string[] }
  | { ok: false; assetId: string; error: EditStateApiError; compactFallbackAssetIds: string[] };
export const EDIT_STATE_AUTOSAVE_DELAY_MS = 5000;

function freshRecord(assetId: string): AssetEditRecord {
  return {
    session: newSession(), loadStatus: 'unloaded', saveStatus: 'idle', revision: 0,
    sourceIdentity: { provider: 'immich', assetId, inputKind: 'immich-preview' },
    savedFingerprint: null, editedThisSession: false, needsCompaction: false,
  };
}

export function useAssetEdits(assetId: string, enabled: boolean) {
  const records = useRef<Record<string, AssetEditRecord>>({});
  // editSession and restoreEditSession replace the session rather than mutating
  // it. Keep one validated snapshot per session/source pair; status-only
  // rerenders and async save responses can reuse its fingerprint.
  const snapshotCache = useRef(new WeakMap<EditSession, Map<string, {
    snapshot: EditStateSnapshot | null; fingerprint: string | null;
  }>>());
  const loads = useRef<Record<string, LoadOperation>>({});
  const saves = useRef<Partial<Record<string, Promise<SaveResult>>>>({});
  const saveGeneration = useRef(0);
  const assetSaveGeneration = useRef<Partial<Record<string, number>>>({});
  const autosaveTimers = useRef<Partial<Record<string, AutosaveTimer>>>({});
  const autosaveGeneration = useRef(0);
  const autosavePaused = useRef(new Set<string>());
  const exitSaving = useRef(false);
  const scheduleAutosaveRef = useRef<(id: string) => void>(() => undefined);
  const activeAssetId = useRef<string | null>(enabled ? assetId : null);
  activeAssetId.current = enabled ? assetId : null;
  const [, render] = useState(0);
  const changed = useCallback(() => render((count) => count + 1), []);
  const getRecord = useCallback((id: string) => records.current[id] ?? freshRecord(id), []);
  const snapshotDataFor = useCallback((record: AssetEditRecord) => {
    const sourceKey = JSON.stringify(record.sourceIdentity);
    let bySource = snapshotCache.current.get(record.session);
    const cached = bySource?.get(sourceKey);
    if (cached) return cached;
    const result = createEditStateSnapshot(record.session, record.sourceIdentity);
    const snapshot = result.ok ? result.value : null;
    const data = { snapshot, fingerprint: snapshot ? JSON.stringify(snapshot) : null };
    if (!bySource) {
      bySource = new Map();
      snapshotCache.current.set(record.session, bySource);
    }
    bySource.set(sourceKey, data);
    return data;
  }, []);
  const snapshotFor = useCallback((record: AssetEditRecord) => snapshotDataFor(record).snapshot, [snapshotDataFor]);
  const fingerprintFor = useCallback((record: AssetEditRecord) => snapshotDataFor(record).fingerprint, [snapshotDataFor]);
  const setRecord = useCallback((id: string, record: AssetEditRecord) => {
    records.current[id] = record;
    changed();
  }, [changed]);

  const cancelAutosave = useCallback((id: string) => {
    const timer = autosaveTimers.current[id];
    if (timer) window.clearTimeout(timer.timeout);
    delete autosaveTimers.current[id];
    autosaveGeneration.current += 1;
  }, []);

  const load = useCallback((id: string) => {
    // A previous Filmstrip transition may have paused this asset's timer. Once
    // it becomes active again, a fresh GET establishes the state to autosave.
    autosavePaused.current.delete(id);
    if (loads.current[id]) {
      loads.current[id].controller.abort();
      window.clearTimeout(loads.current[id].timeout);
    }
    const existingRecord = getRecord(id);
    if (existingRecord.editedThisSession && existingRecord.savedFingerprint !== null
      && (existingRecord.retrySave || fingerprintFor(existingRecord) !== existingRecord.savedFingerprint)) {
      // A failed exit save leaves valuable local edits that must survive a
      // Filmstrip revisit. Keep that dirty session instead of replacing it with
      // a GET result; discard explicitly removes the record and still forces GET.
      const retained = { ...existingRecord, loadStatus: 'ready' as const, loadError: undefined };
      setRecord(id, retained);
      scheduleAutosaveRef.current(id);
      return () => {
        autosavePaused.current.add(id);
        cancelAutosave(id);
        if (records.current[id]) records.current[id] = { ...records.current[id], loadStatus: 'unloaded', organizationUndo: undefined };
      };
    }
    const controller = new AbortController();
    const generation = (loads.current[id]?.generation ?? 0) + 1;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    loads.current[id] = { controller, generation, timeout, promise: Promise.resolve() };
    setRecord(id, { ...getRecord(id), loadStatus: 'loading' });
    const promise = getAssetEditState(id, controller.signal).then((response) => {
      if (loads.current[id]?.generation !== generation || controller.signal.aborted) return;
      const restored = response.state === null ? { ok: true as const, value: newSession() } : restoreEditSession(response.state);
      if (!restored.ok) throw new EditStateApiError('invalid_state');
      const previous = getRecord(id);
      const next: AssetEditRecord = {
        ...freshRecord(id), editedThisSession: previous.editedThisSession, needsCompaction: previous.needsCompaction,
        session: restored.value, loadStatus: 'ready', revision: response.revision ?? 0,
        updatedAt: response.updatedAt, lastSaveId: response.lastSaveId,
        sourceIdentity: response.state?.sourceIdentity ?? freshRecord(id).sourceIdentity,
      };
      setRecord(id, { ...next, savedFingerprint: fingerprintFor(next) });
    }).catch((cause) => {
      if (loads.current[id]?.generation === generation) {
        const error = cause instanceof EditStateApiError ? cause : new EditStateApiError('network');
        setRecord(id, { ...getRecord(id), loadStatus: 'error', loadError: error.kind });
      }
    }).finally(() => window.clearTimeout(timeout));
    loads.current[id] = { controller, generation, timeout, promise };
    return () => {
      autosavePaused.current.add(id);
      cancelAutosave(id);
      const active = loads.current[id];
      if (!active) return;
      window.clearTimeout(active.timeout);
      active.controller.abort();
      active.generation += 1;
      // Re-entering this asset must wait for a fresh GET, even if it was loaded earlier.
      if (records.current[id]) records.current[id] = { ...records.current[id], loadStatus: 'unloaded', organizationUndo: undefined };
    };
  }, [cancelAutosave, fingerprintFor, getRecord, setRecord]);

  useEffect(() => {
    if (!enabled) {
      autosavePaused.current.add(assetId);
      cancelAutosave(assetId);
      return;
    }
    return load(assetId);
  }, [assetId, cancelAutosave, enabled, load]);

  const updateSession = useCallback((current: AssetEditRecord, session: EditSession, organizationUndo?: EditSession) => {
    if (session !== current.session || organizationUndo !== current.organizationUndo) {
      const next = { ...current, session, organizationUndo };
      const currentFingerprint = fingerprintFor(current);
      const nextFingerprint = fingerprintFor(next);
      if (currentFingerprint !== nextFingerprint) {
        next.editedThisSession = true;
        next.needsCompaction = true;
      }
      setRecord(assetId, next);
      // Only changes to the persisted snapshot reset the debounce. Pending UI
      // gestures and viewer-only controls do not change this fingerprint.
      if (currentFingerprint !== nextFingerprint) {
        if (nextFingerprint === next.savedFingerprint && !next.retrySave) cancelAutosave(assetId);
        else scheduleAutosaveRef.current(assetId);
      }
    }
  }, [assetId, cancelAutosave, fingerprintFor, setRecord]);

  const dispatch = useCallback((action: EditAction) => {
    const current = getRecord(assetId);
    if (!enabled || exitSaving.current || current.loadStatus !== 'ready') return;
    if (action.type === 'undo' && current.organizationUndo) {
      updateSession(current, current.organizationUndo);
      return;
    }
    const session = editSession(current.session, action);
    const organizing = action.type === 'clearHistory' || action.type === 'trimHistory';
    const historyChanged = organizing && session.history.length !== current.session.history.length;
    // User edit intentions invalidate restoration even when their value is a
    // no-op. Internal commit callbacks preserve it, including stale callbacks.
    const backup = historyChanged ? structuredClone(current.session)
      : action.type === 'commit' ? current.organizationUndo : undefined;
    updateSession(current, session, backup);
  }, [assetId, enabled, getRecord, updateSession]);

  const organizeHistory = useCallback((operation: 'clearHistory' | 'trimHistory' | 'resetEdits' | 'compactHistory'): boolean => {
    const current = getRecord(assetId);
    if (!enabled || exitSaving.current || current.loadStatus !== 'ready') return false;
    if (operation !== 'compactHistory') {
      dispatch({ type: operation });
      return true;
    }
    // A new organization attempt consumes the previous restoration right,
    // including no-op and failed attempts. A failure leaves the session intact.
    try {
      const result = compactEditSession(current.session, current.sourceIdentity);
      if (!result.ok) {
        updateSession(current, current.session);
        return false;
      }
      const changedHistory = JSON.stringify(result.value.history) !== JSON.stringify(current.session.history)
        || result.value.cursor !== current.session.cursor;
      updateSession(current, changedHistory ? result.value : current.session,
        changedHistory ? structuredClone(current.session) : undefined);
      return true;
    } catch {
      updateSession(current, current.session);
      return false;
    }
  }, [assetId, dispatch, enabled, getRecord, updateSession]);

  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isNativeEditingTarget(event.target)) return;
      const type = undoShortcut(event);
      if (!type) return;
      event.preventDefault();
      dispatch({ type });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dispatch, enabled]);

  const writeSnapshot = useCallback((id: string, snapshotValue: EditStateSnapshot | null, options: {
    allowUnloaded?: boolean; syncSession?: boolean; latestSession?: boolean;
  } = {}): Promise<SaveResult> => {
    if (saves.current[id]) return saves.current[id];
    const current = getRecord(id);
    const canUseInactiveSession = options.allowUnloaded && current.loadStatus === 'unloaded' && current.savedFingerprint !== null;
    if (current.loadStatus !== 'ready' && !canUseInactiveSession) {
      return Promise.resolve({ ok: false, error: new EditStateApiError(current.loadError ?? 'invalid_state') });
    }
    const operationGeneration = ++saveGeneration.current;
    assetSaveGeneration.current[id] = operationGeneration;
    const clearResolvedWarning = (record: AssetEditRecord): AssetEditRecord => {
      if (!record.autosaveError || (record.autosaveErrorGeneration ?? 0) > operationGeneration) return record;
      return { ...record, autosaveError: null, autosaveErrorGeneration: undefined };
    };
    // A network failure may have hidden a committed PUT. Replaying that exact
    // request must precede any newer snapshot, even when local edits diverged.
    const send = async (request: RetrySave): Promise<SaveResult> => {
      setRecord(id, { ...getRecord(id), saveStatus: 'saving', retrySave: request });
      try {
        const response = await putAssetEditState(id, request.snapshot, request.expectedRevision, request.saveId);
        const latest = getRecord(id);
        const canSyncSession = request.syncSession && latest.session === request.liveSession
          && fingerprintFor(latest) === request.liveFingerprint;
        const restored = canSyncSession ? restoreEditSession(request.snapshot) : null;
        let next: AssetEditRecord = { ...latest, session: restored?.ok ? restored.value : latest.session,
          revision: response.revision, updatedAt: response.updatedAt,
          lastSaveId: response.lastSaveId, savedFingerprint: request.fingerprint,
          retrySave: undefined, saveStatus: 'idle' as const };
        if (canSyncSession && restored?.ok) next.needsCompaction = false;
        const clean = fingerprintFor(next) === request.fingerprint;
        if (clean) next = clearResolvedWarning(next);
        setRecord(id, next);
        return { ok: true, clean };
      } catch (cause) {
        const error = cause instanceof EditStateApiError ? cause : new EditStateApiError('network');
        const latest = getRecord(id);
        setRecord(id, { ...latest, saveStatus: 'idle', retrySave: error.kind === 'network' ? request : undefined });
        return { ok: false, error };
      }
    };
    const operation = (async (): Promise<SaveResult> => {
      if (current.retrySave) {
        const confirmed = await send(current.retrySave);
        if (!confirmed.ok || snapshotValue === null) return confirmed;
      }
      if (snapshotValue === null) {
        let latest = getRecord(id);
        const clean = !latest.retrySave && fingerprintFor(latest) === latest.savedFingerprint;
        if (clean && latest.autosaveError) {
          latest = clearResolvedWarning(latest);
          setRecord(id, latest);
        }
        return { ok: true, clean };
      }
      const candidate = options.latestSession ? snapshotFor(getRecord(id)) : snapshotValue;
      const validated = candidate && validateEditStateSnapshot(candidate);
      if (!validated?.ok) return { ok: false, error: new EditStateApiError('invalid_state') };
      const snapshot = validated.value;
      const fingerprint = JSON.stringify(snapshot);
      const latest = getRecord(id);
      if (fingerprint === latest.savedFingerprint) {
        const clean = !latest.retrySave && fingerprintFor(latest) === fingerprint;
        if (clean && latest.autosaveError) setRecord(id, clearResolvedWarning(latest));
        return { ok: true, clean };
      }
      return send({ fingerprint, expectedRevision: latest.revision, saveId: createEditStateSaveId(),
        snapshot, syncSession: options.syncSession ?? false, liveFingerprint: fingerprintFor(latest), liveSession: latest.session });
    })().finally(() => { delete saves.current[id]; });
    saves.current[id] = operation;
    return operation;
  }, [fingerprintFor, getRecord, setRecord, snapshotFor]);

  const save = useCallback((id: string): Promise<SaveResult> => {
    if (saves.current[id]) return saves.current[id];
    const current = getRecord(id);
    if (current.loadStatus !== 'ready') return Promise.resolve({ ok: false, error: new EditStateApiError(current.loadError ?? 'invalid_state') });
    const snapshot = snapshotFor(current);
    if (!snapshot) return Promise.resolve({ ok: false, error: new EditStateApiError('invalid_state') });
    return writeSnapshot(id, snapshot, { latestSession: true });
  }, [getRecord, snapshotFor, writeSnapshot]);

  const scheduleAutosave = useCallback((id: string) => {
    cancelAutosave(id);
    const current = getRecord(id);
    if (exitSaving.current || activeAssetId.current !== id || autosavePaused.current.has(id) || current.loadStatus !== 'ready'
      || (fingerprintFor(current) === current.savedFingerprint && !current.retrySave)) return;

    const generation = ++autosaveGeneration.current;
    const timeout = window.setTimeout(() => {
      const timer = autosaveTimers.current[id];
      if (!timer || timer.generation !== generation) return;
      delete autosaveTimers.current[id];
      if (exitSaving.current || activeAssetId.current !== id || autosavePaused.current.has(id)) return;
      const latest = getRecord(id);
      if (latest.loadStatus !== 'ready' || (fingerprintFor(latest) === latest.savedFingerprint && !latest.retrySave)
        || saves.current[id]) return;

      const pendingSave = save(id);
      const operationGeneration = assetSaveGeneration.current[id];
      void pendingSave.then((result) => {
        if (exitSaving.current || activeAssetId.current !== id || autosavePaused.current.has(id)) return;
        if (!result.ok) {
          if (assetSaveGeneration.current[id] !== operationGeneration) return;
          const record = getRecord(id);
          setRecord(id, { ...record, autosaveError: result.error.kind,
            autosaveErrorGeneration: operationGeneration });
        } else if (!result.clean && !autosaveTimers.current[id]) {
          // A newer edit's timer may have expired while the previous PUT was in
          // flight. Give that newer state a fresh quiet period after the PUT.
          scheduleAutosave(id);
        }
      });
    }, EDIT_STATE_AUTOSAVE_DELAY_MS);
    autosaveTimers.current[id] = { timeout, generation };
  }, [cancelAutosave, fingerprintFor, getRecord, save, setRecord]);
  scheduleAutosaveRef.current = scheduleAutosave;

  const pauseAutosave = useCallback((id: string) => {
    autosavePaused.current.add(id);
    cancelAutosave(id);
  }, [cancelAutosave]);

  const resumeAutosave = useCallback((id: string) => {
    autosavePaused.current.delete(id);
    scheduleAutosave(id);
  }, [scheduleAutosave]);

  const saveEditedAssetsForExit = useCallback(async (compactHistory = COMPACT_HISTORY_ON_EXIT): Promise<ExitSaveResult> => {
    if (exitSaving.current) return { ok: false, assetId, error: new EditStateApiError('unexpected'), compactFallbackAssetIds: [] };
    exitSaving.current = true;
    for (const [id, record] of Object.entries(records.current)) {
      records.current[id] = { ...record, organizationUndo: undefined };
    }
    changed();
    const assetIds = Object.entries(records.current)
      .filter(([, record]) => record.editedThisSession)
      .map(([id]) => id);
    const pauseIds = new Set([...assetIds, assetId, ...Object.keys(autosaveTimers.current)]);
    for (const id of pauseIds) pauseAutosave(id);

    const compactFallbackAssetIds: string[] = [];
    const failure = (id: string, error: EditStateApiError): ExitSaveResult => ({
      ok: false, assetId: id, error, compactFallbackAssetIds,
    });

    for (const id of assetIds) {
      let current = getRecord(id);
      if (current.loadStatus === 'loading') {
        await loads.current[id]?.promise;
        current = getRecord(id);
      }
      if (current.loadStatus === 'error') return failure(id, new EditStateApiError(current.loadError ?? 'invalid_state'));
      if (current.loadStatus === 'loading' || current.savedFingerprint === null) {
        return failure(id, new EditStateApiError('invalid_state'));
      }

      const existingSave = saves.current[id];
      if (existingSave) {
        const inFlightResult = await existingSave;
        if (!inFlightResult.ok && inFlightResult.error.kind !== 'network') return failure(id, inFlightResult.error);
      }

      // This also covers a network failure that settled before exit began.
      // The compact target is computed only after the old request is confirmed.
      const confirmed = await writeSnapshot(id, null, { allowUnloaded: true });
      if (!confirmed.ok) return failure(id, confirmed.error);

      current = getRecord(id);
      if (current.loadStatus === 'error' || current.loadStatus === 'loading') {
        return failure(id, new EditStateApiError(current.loadError ?? 'invalid_state'));
      }
      const normalSnapshot = snapshotFor(current);
      if (!normalSnapshot) return failure(id, new EditStateApiError('invalid_state'));

      let selectedSnapshot = normalSnapshot;
      let compactedSuccessfully = false;
      let compactionFailed = false;
      if (compactHistory && current.needsCompaction) {
        try {
          const compacted = compactEditStateSnapshot(normalSnapshot);
          if (compacted.ok) {
            const validated = validateEditStateSnapshot(compacted.value);
            if (validated.ok) {
              selectedSnapshot = validated.value;
              compactedSuccessfully = true;
            } else compactionFailed = true;
          } else compactionFailed = true;
        } catch {
          compactionFailed = true;
        }
        if (compactionFailed) compactFallbackAssetIds.push(id);
      }

      const selectedFingerprint = JSON.stringify(selectedSnapshot);
      if (selectedFingerprint === current.savedFingerprint) {
        if (compactedSuccessfully) {
          const restored = restoreEditSession(selectedSnapshot);
          if (!restored.ok) return failure(id, new EditStateApiError('invalid_state'));
          setRecord(id, { ...current, session: restored.value, needsCompaction: false });
        } else if (!compactHistory && current.needsCompaction) {
          setRecord(id, { ...current, needsCompaction: false });
        }
        continue;
      }

      const saved = await writeSnapshot(id, selectedSnapshot, {
        allowUnloaded: true,
        syncSession: compactedSuccessfully,
      });
      if (!saved.ok) return failure(id, saved.error);
      if (!saved.clean) return failure(id, new EditStateApiError('invalid_state'));
      if (!compactHistory || compactedSuccessfully) {
        const latest = getRecord(id);
        setRecord(id, { ...latest, needsCompaction: false });
      }
    }
    return { ok: true, compactFallbackAssetIds };
  }, [assetId, changed, getRecord, pauseAutosave, setRecord, snapshotFor, writeSnapshot]);

  const resumeAfterExitFailure = useCallback(() => {
    exitSaving.current = false;
    for (const [id, record] of Object.entries(records.current)) {
      if (!record.editedThisSession) continue;
      autosavePaused.current.delete(id);
      scheduleAutosave(id);
    }
  }, [scheduleAutosave]);

  const discard = useCallback((id: string) => {
    cancelAutosave(id);
    autosavePaused.current.delete(id);
    if (loads.current[id]) {
      loads.current[id].controller.abort();
      window.clearTimeout(loads.current[id].timeout);
      loads.current[id].generation += 1;
    }
    delete records.current[id];
    changed();
  }, [cancelAutosave, changed]);

  const current = getRecord(assetId);
  const dirty = current.loadStatus === 'ready'
    && (current.retrySave !== undefined || fingerprintFor(current) !== current.savedFingerprint);
  return {
    session: current.session, dispatch, organizeHistory,
    hasOrganizationUndo: !!current.organizationUndo,
    canUndo: !!current.organizationUndo || current.session.cursor > 0 || !!current.session.pending,
    loadStatus: current.loadStatus, saveStatus: current.saveStatus,
    revision: current.revision, dirty, save, discard, retryLoad: () => load(assetId),
    pauseAutosave, resumeAutosave, autosaveError: current.autosaveError ?? null,
    saveEditedAssetsForExit, resumeAfterExitFailure,
  };
}
