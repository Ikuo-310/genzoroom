import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPACT_HISTORY_ON_EXIT,
  compactEditStateSnapshot,
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
  loadError?: EditStateApiError['kind'];
  editedThisSession: boolean;
  needsCompaction: boolean;
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
        if (records.current[id]) records.current[id] = { ...records.current[id], loadStatus: 'unloaded' };
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
      if (records.current[id]) records.current[id] = { ...records.current[id], loadStatus: 'unloaded' };
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

  const dispatch = useCallback((action: EditAction) => {
    const current = getRecord(assetId);
    if (!enabled || exitSaving.current || current.loadStatus !== 'ready') return;
    const session = editSession(current.session, action);
    if (session !== current.session) {
      const next = { ...current, session };
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
  }, [assetId, cancelAutosave, enabled, fingerprintFor, getRecord, setRecord]);

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
    // A network failure may have hidden a committed PUT. Replaying that exact
    // request must precede any newer snapshot, even when local edits diverged.
    const send = async (request: RetrySave): Promise<SaveResult> => {
      setRecord(id, { ...getRecord(id), saveStatus: 'saving', retrySave: request });
      try {
        const response = await putAssetEditState(id, request.snapshot, request.expectedRevision, request.saveId);
        const latest = getRecord(id);
        const canSyncSession = request.syncSession && fingerprintFor(latest) === request.liveFingerprint;
        const restored = canSyncSession ? restoreEditSession(request.snapshot) : null;
        const next = { ...latest, session: restored?.ok ? restored.value : latest.session,
          revision: response.revision, updatedAt: response.updatedAt,
          lastSaveId: response.lastSaveId, savedFingerprint: request.fingerprint,
          retrySave: undefined, saveStatus: 'idle' as const };
        if (canSyncSession && restored?.ok) next.needsCompaction = false;
        setRecord(id, next);
        return { ok: true, clean: fingerprintFor(next) === request.fingerprint };
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
        const latest = getRecord(id);
        return { ok: true, clean: fingerprintFor(latest) === latest.savedFingerprint };
      }
      const candidate = options.latestSession ? snapshotFor(getRecord(id)) : snapshotValue;
      const validated = candidate && validateEditStateSnapshot(candidate);
      if (!validated?.ok) return { ok: false, error: new EditStateApiError('invalid_state') };
      const snapshot = validated.value;
      const fingerprint = JSON.stringify(snapshot);
      const latest = getRecord(id);
      if (fingerprint === latest.savedFingerprint) {
        return { ok: true, clean: fingerprintFor(latest) === fingerprint };
      }
      return send({ fingerprint, expectedRevision: latest.revision, saveId: createEditStateSaveId(),
        snapshot, syncSession: options.syncSession ?? false, liveFingerprint: fingerprintFor(latest) });
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

      void save(id).then((result) => {
        if (exitSaving.current || activeAssetId.current !== id || autosavePaused.current.has(id)) return;
        if (!result.ok) {
          const record = getRecord(id);
          setRecord(id, { ...record, autosaveError: result.error.kind });
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
  }, [assetId, getRecord, pauseAutosave, setRecord, snapshotFor, writeSnapshot]);

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
    session: current.session, dispatch, loadStatus: current.loadStatus, saveStatus: current.saveStatus,
    revision: current.revision, dirty, save, discard, retryLoad: () => load(assetId),
    pauseAutosave, resumeAutosave, autosaveError: current.autosaveError ?? null,
    saveEditedAssetsForExit, resumeAfterExitFailure,
  };
}
