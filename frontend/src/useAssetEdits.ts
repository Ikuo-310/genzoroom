import { useCallback, useEffect, useRef, useState } from 'react';
import { createEditStateSnapshot, restoreEditSession, type EditSourceIdentity, type EditStateSnapshot } from './editState';
import { createEditStateSaveId, EditStateApiError, getAssetEditState, putAssetEditState } from './editStateApi';
import { editSession, newSession, type EditAction, type EditSession } from './editing';
import { isNativeEditingTarget, undoShortcut } from './editShortcuts';

type LoadStatus = 'unloaded' | 'loading' | 'ready' | 'error';
type SaveStatus = 'idle' | 'saving';
type RetrySave = { fingerprint: string; expectedRevision: number; saveId: string };
type AutosaveTimer = { timeout: number; generation: number };
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
};

export type SaveResult = { ok: true; clean: boolean } | { ok: false; error: EditStateApiError };
export const EDIT_STATE_AUTOSAVE_DELAY_MS = 5000;

function freshRecord(assetId: string): AssetEditRecord {
  return {
    session: newSession(), loadStatus: 'unloaded', saveStatus: 'idle', revision: 0,
    sourceIdentity: { provider: 'immich', assetId, inputKind: 'immich-preview' },
    savedFingerprint: null,
  };
}

function snapshotFor(record: AssetEditRecord): EditStateSnapshot | null {
  const result = createEditStateSnapshot(record.session, record.sourceIdentity);
  return result.ok ? result.value : null;
}

function fingerprintFor(record: AssetEditRecord): string | null {
  const snapshot = snapshotFor(record);
  return snapshot ? JSON.stringify(snapshot) : null;
}

export function useAssetEdits(assetId: string, enabled: boolean) {
  const records = useRef<Record<string, AssetEditRecord>>({});
  const loads = useRef<Record<string, { controller: AbortController; generation: number; timeout: number }>>({});
  const saves = useRef<Partial<Record<string, Promise<SaveResult>>>>({});
  const autosaveTimers = useRef<Partial<Record<string, AutosaveTimer>>>({});
  const autosaveGeneration = useRef(0);
  const autosavePaused = useRef(new Set<string>());
  const scheduleAutosaveRef = useRef<(id: string) => void>(() => undefined);
  const activeAssetId = useRef<string | null>(enabled ? assetId : null);
  activeAssetId.current = enabled ? assetId : null;
  const [, render] = useState(0);
  const changed = useCallback(() => render((count) => count + 1), []);
  const getRecord = useCallback((id: string) => records.current[id] ?? freshRecord(id), []);
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
    const controller = new AbortController();
    const generation = (loads.current[id]?.generation ?? 0) + 1;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    loads.current[id] = { controller, generation, timeout };
    setRecord(id, { ...getRecord(id), loadStatus: 'loading' });
    void getAssetEditState(id, controller.signal).then((response) => {
      if (loads.current[id]?.generation !== generation || controller.signal.aborted) return;
      const restored = response.state === null ? { ok: true as const, value: newSession() } : restoreEditSession(response.state);
      if (!restored.ok) throw new EditStateApiError('invalid_state');
      const next: AssetEditRecord = {
        ...freshRecord(id), session: restored.value, loadStatus: 'ready', revision: response.revision ?? 0,
        updatedAt: response.updatedAt, lastSaveId: response.lastSaveId,
        sourceIdentity: response.state?.sourceIdentity ?? freshRecord(id).sourceIdentity,
      };
      setRecord(id, { ...next, savedFingerprint: fingerprintFor(next) });
    }).catch(() => {
      if (loads.current[id]?.generation === generation) {
        setRecord(id, { ...getRecord(id), loadStatus: 'error' });
      }
    }).finally(() => window.clearTimeout(timeout));
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
  }, [cancelAutosave, getRecord, setRecord]);

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
    if (!enabled || current.loadStatus !== 'ready') return;
    const session = editSession(current.session, action);
    if (session !== current.session) {
      const next = { ...current, session };
      if (current.retrySave && fingerprintFor(next) !== current.retrySave.fingerprint) next.retrySave = undefined;
      setRecord(assetId, next);
      // Only changes to the persisted snapshot reset the debounce. Pending UI
      // gestures and viewer-only controls do not change this fingerprint.
      if (fingerprintFor(current) !== fingerprintFor(next)) {
        if (fingerprintFor(next) === next.savedFingerprint) cancelAutosave(assetId);
        else scheduleAutosaveRef.current(assetId);
      }
    }
  }, [assetId, cancelAutosave, enabled, getRecord, setRecord]);

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

  const save = useCallback((id: string): Promise<SaveResult> => {
    if (saves.current[id]) return saves.current[id];
    const current = getRecord(id);
    if (current.loadStatus !== 'ready') return Promise.resolve({ ok: false, error: new EditStateApiError('invalid_state') });
    const snapshot = snapshotFor(current);
    if (!snapshot) return Promise.resolve({ ok: false, error: new EditStateApiError('invalid_state') });
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === current.savedFingerprint) return Promise.resolve({ ok: true, clean: true });
    const expectedRevision = current.revision;
    const saveId = current.retrySave?.fingerprint === fingerprint && current.retrySave.expectedRevision === expectedRevision
      ? current.retrySave.saveId : createEditStateSaveId();
    setRecord(id, { ...current, saveStatus: 'saving', retrySave: { fingerprint, expectedRevision, saveId } });
    const operation = putAssetEditState(id, snapshot, expectedRevision, saveId).then((response): SaveResult => {
      const latest = getRecord(id);
      const next = { ...latest, revision: response.revision, updatedAt: response.updatedAt,
        lastSaveId: response.lastSaveId, savedFingerprint: fingerprint, retrySave: undefined, saveStatus: 'idle' as const };
      setRecord(id, next);
      return { ok: true, clean: fingerprintFor(next) === fingerprint };
    }).catch((cause): SaveResult => {
      const error = cause instanceof EditStateApiError ? cause : new EditStateApiError('network');
      const latest = getRecord(id);
      setRecord(id, { ...latest, saveStatus: 'idle', retrySave: error.kind === 'network' ? latest.retrySave : undefined });
      return { ok: false, error };
    }).finally(() => { delete saves.current[id]; });
    saves.current[id] = operation;
    return operation;
  }, [getRecord, setRecord]);

  const scheduleAutosave = useCallback((id: string) => {
    cancelAutosave(id);
    const current = getRecord(id);
    if (activeAssetId.current !== id || autosavePaused.current.has(id) || current.loadStatus !== 'ready'
      || fingerprintFor(current) === current.savedFingerprint) return;

    const generation = ++autosaveGeneration.current;
    const timeout = window.setTimeout(() => {
      const timer = autosaveTimers.current[id];
      if (!timer || timer.generation !== generation) return;
      delete autosaveTimers.current[id];
      if (activeAssetId.current !== id || autosavePaused.current.has(id)) return;
      const latest = getRecord(id);
      if (latest.loadStatus !== 'ready' || fingerprintFor(latest) === latest.savedFingerprint || saves.current[id]) return;

      void save(id).then((result) => {
        if (activeAssetId.current !== id || autosavePaused.current.has(id)) return;
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
  }, [cancelAutosave, getRecord, save, setRecord]);
  scheduleAutosaveRef.current = scheduleAutosave;

  const pauseAutosave = useCallback((id: string) => {
    autosavePaused.current.add(id);
    cancelAutosave(id);
  }, [cancelAutosave]);

  const resumeAutosave = useCallback((id: string) => {
    autosavePaused.current.delete(id);
    scheduleAutosave(id);
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
  const dirty = current.loadStatus === 'ready' && fingerprintFor(current) !== current.savedFingerprint;
  return {
    session: current.session, dispatch, loadStatus: current.loadStatus, saveStatus: current.saveStatus,
    revision: current.revision, dirty, save, discard, retryLoad: () => load(assetId),
    pauseAutosave, resumeAutosave, autosaveError: current.autosaveError ?? null,
  };
}
