import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RecentAsset } from './assets';
import { ExportQueueApiError, isExportQueueMutationOutcomeUnknown, type ExportQueueStatus } from './exportQueueApi';
import { flattenExportQueueDisplay, groupExportQueueAssets, uniqueExportQueueItems } from './exportQueueDisplay';
import { frontendLogger } from './frontendLogging';
import type { ExportQueueState } from './useExportQueue';
import { useExportQueueAssets } from './useExportQueueAssets';
import { usePhotoSelection } from './usePhotoSelection';
import { blurPhotoSelectionCheckboxWhenSelectionEnds } from './photoSelection';

export type ExportManagementQueue = Pick<ExportQueueState, 'items' | 'loaded' | 'canonical' | 'loading' | 'error' | 'enqueue' | 'dequeue' | 'refresh' | 'mutationFor'>
  & Partial<Pick<ExportQueueState, 'retry' | 'runtime' | 'cancelRuntime' | 'cancelling' | 'startRuntime' | 'starting'>>;
export const isMutableExportStatus = (status: ExportQueueStatus | undefined) => status === 'queued' || status === 'failed';
type ManagementError = 'locked' | 'removeFailed' | 'removePartialFailed' | 'queueRestoreFailed' | 'queueRestorePartialFailed' | 'retryFailed' | 'cancelFailed' | 'startFailed';
type ExportConfirmation = { kind: 'start'; assetIds: string[] } | { kind: 'retry'; assetIds: string[] } | { kind: 'stop'; runId: string };
type ArmedUndoRecord = { kind: 'armed'; changes: Array<{ assetId: string; wasArmed: boolean }> };
type QueueRemovalUndoRecord = { kind: 'queueRemoval'; removed: Array<{ assetId: string; wasArmed: boolean }> };
type ExportUndoRecord = ArmedUndoRecord | QueueRemovalUndoRecord;

function log(level: 'debug' | 'info' | 'warn' | 'error', event: string, context: Record<string, string | number>) {
  try { frontendLogger.add({ level, component: 'export_management', event, context }); }
  catch { /* Diagnostics must not change Queue removal outcomes. */ }
}

export function useExportManagement(queue: ExportManagementQueue, active: boolean) {
  const selection = usePhotoSelection();
  const [armedIds, setArmedIds] = useState<Set<string>>(() => new Set());
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState<ManagementError | null>(null);
  const [confirmation, setConfirmation] = useState<ExportConfirmation | null>(null);
  const [retryStarting, setRetryStarting] = useState(false);
  const [retryRunId, setRetryRunId] = useState<string | null>(null);
  const [retryStartUncertain, setRetryStartUncertain] = useState(false);
  const confirmationRef = useRef<ExportConfirmation | null>(null);
  const operationRef = useRef(false);
  const undoRecord = useRef<ExportUndoRecord | null>(null);
  const [undoing, setUndoing] = useState(false);
  const mounted = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active && confirmationRef.current) {
      confirmationRef.current = null; setConfirmation(null); operationRef.current = false;
    }
  }, [active]);

  const items = uniqueExportQueueItems(queue.items);
  const metadata = useExportQueueAssets(items, active && queue.loaded);
  const previousReadyAssets = useRef<RecentAsset[]>([]);
  if (metadata.status === 'ready') previousReadyAssets.current = metadata.assets;
  // Successful DELETEs must remove cards and collapse groups immediately while survivor metadata refreshes.
  const previousById = new Map(previousReadyAssets.current.map(asset => [asset.id.toLowerCase(), asset]));
  const removalOnly = items.length < previousById.size && items.every(item => previousById.has(item.assetId.toLowerCase()));
  const resolvedAssets = metadata.status === 'ready' ? metadata.assets
    : metadata.status === 'loading' && removalOnly ? previousReadyAssets.current : [];
  const assetsById = new Map(resolvedAssets.map(asset => [asset.id.toLowerCase(), asset]));
  const message = queue.error ? 'queueLoadFailed' : !queue.loaded || !queue.canonical && queue.loading ? 'queueLoading'
    : !queue.canonical ? 'queueLoadFailed' : !items.length ? 'empty'
    : metadata.status === 'error' ? 'metadataLoadFailed' : resolvedAssets.length ? null : 'metadataLoading';
  const entries = items.flatMap(item => {
    const asset = assetsById.get(item.assetId.toLowerCase());
    return asset ? [{ item, asset }] : [];
  });
  const rows = groupExportQueueAssets(entries);
  const failedIds = items.filter(item => item.status === 'failed').map(item => item.assetId.toLowerCase());
  const retryRunActive = !!retryRunId && (queue.runtime == null
    || queue.runtime.status === 'active' && queue.runtime.runId === retryRunId);
  const retryPriority = failedIds.length > 0 || confirmation?.kind === 'retry' || retryStarting || retryRunActive || retryStartUncertain;
  const armedAvailableIds = items.filter(item => isMutableExportStatus(item.status)).map(item => item.assetId.toLowerCase());
  const armedAvailableKey = JSON.stringify(armedAvailableIds);
  const mutableIds = items.filter(item => retryPriority ? item.status === 'failed' : isMutableExportStatus(item.status))
    .map(item => item.assetId.toLowerCase());
  const mutableKey = JSON.stringify(mutableIds);
  useEffect(() => {
    const available = new Set<string>(JSON.parse(mutableKey));
    const armedAvailable = new Set<string>(JSON.parse(armedAvailableKey));
    selection.retainAvailable(available);
    setArmedIds(previous => {
      const next = new Set([...previous].filter(id => armedAvailable.has(id)));
      return next.size === previous.size ? previous : next;
    });
    // Do not invalidate an older record mid-Q; a failed batch must leave it usable.
    if (!operationRef.current && undoRecord.current) {
      const record = undoRecord.current;
      const currentById = new Map(queueRef.current.items.map(item => [item.assetId.toLowerCase(), item]));
      const reconciled = record.kind === 'armed'
        ? record.changes.filter(change => isMutableExportStatus(currentById.get(change.assetId)?.status))
        : record.removed.filter(change => !currentById.has(change.assetId));
      undoRecord.current = reconciled.length ? record.kind === 'armed'
        ? { kind: 'armed', changes: reconciled } : { kind: 'queueRemoval', removed: reconciled } : null;
    }
  }, [mutableKey, armedAvailableKey, selection.retainAvailable, removing, undoing]);
  const mutable = new Set(mutableIds);
  const selectedIds = selection.selectedIds.filter(id => mutable.has(id));
  const selectionMode = active && selectedIds.length > 0;
  const previousSelectionMode = useRef(selectionMode);
  useLayoutEffect(() => {
    // Clearing selection hides the checkbox, so release its focus just as Gallery does.
    if (document.activeElement?.closest('.export-queue-card')) {
      blurPhotoSelectionCheckboxWhenSelectionEnds(document.activeElement, previousSelectionMode.current, selectionMode);
    }
    previousSelectionMode.current = selectionMode;
  }, [selectionMode]);
  const visualIds = message ? [] : flattenExportQueueDisplay(rows)
    .filter(entry => mutable.has(entry.item.assetId.toLowerCase())).map(entry => entry.item.assetId.toLowerCase());
  const allSelectedArmed = selectedIds.length > 0 && selectedIds.every(id => armedIds.has(id));
  const runtimeIdle = queue.runtime?.status === null;
  const canRetryFailed = active && queue.loaded && queue.canonical && !queue.loading && !queue.error && !message && !removing && !undoing
    && !confirmation && !!queue.retry && !!queue.startRuntime && runtimeIdle && !queue.starting && !queue.cancelling
    && failedIds.length >= 1 && failedIds.length <= 100 && failedIds.every(id => !queue.mutationFor(id).operation);
  const requestRetryFailed = () => {
    if (operationRef.current || !canRetryFailed) return false;
    operationRef.current = true;
    confirmationRef.current = { kind: 'retry', assetIds: [...failedIds] };
    setConfirmation(confirmationRef.current); return true;
  };
  const startTargets = items.filter(item => item.status === 'queued' && armedIds.has(item.assetId.toLowerCase())
    && !queue.mutationFor(item.assetId).operation).map(item => item.assetId.toLowerCase());
  const canStart = active && queue.loaded && queue.canonical && !queue.loading && !queue.error && !message && !removing && !undoing
    && !confirmation && !!queue.startRuntime && runtimeIdle && !queue.starting && !queue.cancelling
    && !retryPriority && startTargets.length >= 1 && startTargets.length <= 100;
  const requestStart = () => {
    if (operationRef.current || !canStart) return false;
    operationRef.current = true;
    confirmationRef.current = { kind: 'start', assetIds: [...startTargets] };
    setConfirmation(confirmationRef.current); return true;
  };
  const cancelExport = () => {
    if (operationRef.current || !queue.runtime?.stopAllowed || queue.cancelling || !queue.cancelRuntime) return false;
    operationRef.current = true;
    confirmationRef.current = { kind: 'stop', runId: queue.runtime.runId! };
    setConfirmation(confirmationRef.current); return true;
  };
  const cancelConfirmation = () => {
    confirmationRef.current = null; setConfirmation(null); operationRef.current = false;
  };
  const confirmExport = () => {
    const intent = confirmationRef.current;
    if (!intent) return false;
    // Consume synchronously so repeated activation cannot dispatch a second remote operation.
    confirmationRef.current = null; setConfirmation(null); setRemoving(true); setRemovalError(null);
    if (intent.kind === 'retry') setRetryStarting(true);
    void (async () => {
      let startAttempted = false;
      try {
        const latest = queueRef.current;
        if (intent.kind === 'start' || intent.kind === 'retry') {
          if (!latest.canonical || !latest.startRuntime || latest.runtime?.status !== null || latest.starting || latest.cancelling
            || intent.assetIds.some(id => latest.items.find(item => item.assetId.toLowerCase() === id)?.status !== (intent.kind === 'retry' ? 'failed' : 'queued')
              || latest.mutationFor(id).operation) || (intent.kind === 'retry' && !latest.retry)) throw new ExportQueueApiError('locked');
          if (intent.kind === 'retry') {
            // Retry and Start are one confirmed intent; any batch failure prevents a partial run.
            await latest.retry!(intent.assetIds);
          }
          startAttempted = true;
          const started = await latest.startRuntime(intent.assetIds);
          if (intent.kind === 'retry') setRetryRunId(started?.status === 'active' ? started.runId : null);
          if (mounted.current) {
            // Fast terminal failures may finish between polls; accepted targets still leave armed state.
            const started = new Set(intent.assetIds);
            setArmedIds(previous => new Set([...previous].filter(id => !started.has(id))));
          }
          log('info', 'run.startRequested', { count: intent.assetIds.length });
        } else {
          if (!latest.cancelRuntime || latest.runtime?.runId !== intent.runId || !latest.runtime.stopAllowed || latest.cancelling)
            throw new ExportQueueApiError('locked');
          await latest.cancelRuntime(); log('info', 'run.stopRequested', {});
        }
      }
      catch {
        if (intent.kind === 'retry') {
          // A committed run can outlive a lost Start response; unknown status must retain Retry intent.
          if (startAttempted && mounted.current) setRetryStartUncertain(true);
          try { await queueRef.current.refresh(); } catch { /* Keep the original safe failure and refresh best-effort. */ }
        }
        if (mounted.current) setRemovalError(intent.kind === 'stop' ? 'cancelFailed' : intent.kind === 'retry' ? 'retryFailed' : 'startFailed');
        log('error', intent.kind === 'stop' ? 'run.stopRequestFailed' : intent.kind === 'retry' ? 'retry.startRequestFailed' : 'run.startRequestFailed', {});
      }
      finally { if (mounted.current) { if (intent.kind === 'retry') setRetryStarting(false); operationRef.current = false; setRemoving(false); } }
    })();
    return true;
  };
  useEffect(() => {
    if (retryStartUncertain && queue.runtime != null) {
      if (queue.runtime.status === 'active') setRetryRunId(queue.runtime.runId);
      setRetryStartUncertain(false);
    }
    if (retryRunId && queue.runtime != null
      && (queue.runtime.status !== 'active' || queue.runtime.runId !== retryRunId)) setRetryRunId(null);
  }, [queue.runtime?.runId, queue.runtime?.status, retryRunId, retryStartUncertain]);
  const canOperate = (id: string) => queue.canonical && !operationRef.current && !message && mutable.has(id.toLowerCase())
    && !queue.mutationFor(id).operation;
  const selectOnly = (id: string) => { if (canOperate(id)) selection.selectOnly(id.toLowerCase()); };
  const toggleSelection = (id: string) => { if (canOperate(id)) selection.toggle(id.toLowerCase()); };
  const extendRange = (id: string) => { if (canOperate(id)) selection.extendRange(id.toLowerCase(), visualIds); };
  const clear = () => { if (!operationRef.current) selection.clear(); };
  const selectAll = () => {
    if (operationRef.current || !visualIds.length) return false;
    selection.selectVisible(visualIds.filter(id => mutable.has(id) && !queue.mutationFor(id).operation));
    return true;
  };
  const toggleArmed = () => {
    if (operationRef.current || !selectedIds.length || message) return false;
    const targets = selectedIds.filter(id => !queue.mutationFor(id).operation);
    if (!targets.length) return false;
    const turnOn = targets.some(id => !armedIds.has(id));
    const changes = targets.filter(id => armedIds.has(id) !== turnOn)
      .map(assetId => ({ assetId, wasArmed: armedIds.has(assetId) }));
    if (!changes.length) return false;
    undoRecord.current = { kind: 'armed', changes };
    setArmedIds(previous => {
      const next = new Set(previous);
      changes.forEach(({ assetId }) => { if (turnOn) next.add(assetId); else next.delete(assetId); });
      return next;
    });
    return true;
  };
  const removeSelected = () => {
    if (!queueRef.current.canonical || operationRef.current || !selectedIds.length || message) return false;
    const selected = new Set(selectedIds);
    // Snapshot IDs in Queue order; selection changes cannot expand an in-flight batch.
    const targets = items.filter(item => selected.has(item.assetId.toLowerCase()) && !queue.mutationFor(item.assetId).operation)
      .map(item => item.assetId.toLowerCase());
    if (!targets.length) return false;
    operationRef.current = true;
    setRemoving(true); setRemovalError(null);
    const wasArmed = new Map(targets.map(assetId => [assetId, armedIds.has(assetId)]));
    log('debug', 'remove.started', { count: targets.length });
    void (async () => {
      let succeeded = 0, failed = 0, locked = 0, outcomeUnknown = false;
      const removed: QueueRemovalUndoRecord['removed'] = [];
      for (const assetId of targets) {
        if (!mounted.current) return;
        const current = queueRef.current.items.find(item => item.assetId.toLowerCase() === assetId);
        if (!current) continue;
        try {
          if (!isMutableExportStatus(current.status)) throw new ExportQueueApiError('locked');
          await queueRef.current.dequeue(assetId);
          succeeded++;
          removed.push({ assetId, wasArmed: wasArmed.get(assetId) ?? false });
        } catch (error) {
          failed++;
          if (error instanceof ExportQueueApiError && error.kind === 'locked') locked++;
          log('debug', 'remove.item_failed', { assetId, errorCode: error instanceof ExportQueueApiError ? error.kind : 'operation_failed' });
          if (isExportQueueMutationOutcomeUnknown(error)) { outcomeUnknown = true; break; }
        }
      }
      if (!mounted.current) return;
      if (failed && !outcomeUnknown) {
        try { await queueRef.current.refresh(); }
        catch { log('error', 'remove.refresh_failed', { count: targets.length }); }
      }
      if (!mounted.current) return;
      setRemovalError(failed ? succeeded ? 'removePartialFailed' : locked === failed ? 'locked' : 'removeFailed' : null);
      if (removed.length) undoRecord.current = { kind: 'queueRemoval', removed };
      log(failed ? succeeded ? 'warn' : 'error' : 'info', 'remove.completed', { count: targets.length, succeeded, failed, locked });
      operationRef.current = false; setRemoving(false);
    })();
    return true;
  };
  const undo = () => {
    if (operationRef.current || !undoRecord.current) return false;
    const record = undoRecord.current;
    if (record.kind === 'queueRemoval' && !queueRef.current.canonical) return false;
    const currentItems = queueRef.current.items;
    if (record.kind === 'armed') {
      const valid = record.changes.filter(change => isMutableExportStatus(
        currentItems.find(item => item.assetId.toLowerCase() === change.assetId)?.status,
      ) && !queueRef.current.mutationFor(change.assetId).operation);
      undoRecord.current = null;
      if (!valid.length) return false;
      operationRef.current = true;
      setArmedIds(previous => {
        const next = new Set(previous);
        valid.forEach(({ assetId, wasArmed }) => { if (wasArmed) next.add(assetId); else next.delete(assetId); });
        return next;
      });
      operationRef.current = false;
      return true;
    }

    // Consume before awaiting so repeat key events cannot enqueue the same removal twice.
    undoRecord.current = null;
    operationRef.current = true;
    setUndoing(true); setRemovalError(null);
    void (async () => {
      let restored = 0, failed = 0, outcomeUnknown = false;
      const restoreArmed: string[] = [];
      for (const removedItem of record.removed) {
        if (!mounted.current) return;
        const current = queueRef.current.items.find(item => item.assetId.toLowerCase() === removedItem.assetId);
        if (current) {
          if (isMutableExportStatus(current.status) && !queueRef.current.mutationFor(removedItem.assetId).operation) {
            restored++;
            if (removedItem.wasArmed) restoreArmed.push(removedItem.assetId);
          } else failed++;
          continue;
        }
        if (queueRef.current.mutationFor(removedItem.assetId).operation) { failed++; continue; }
        try {
          await queueRef.current.enqueue([removedItem.assetId]);
          restored++;
          if (removedItem.wasArmed) restoreArmed.push(removedItem.assetId);
        } catch (error) {
          failed++;
          if (isExportQueueMutationOutcomeUnknown(error)) { outcomeUnknown = true; break; }
        }
      }
      if (!mounted.current) return;
      if (failed && !outcomeUnknown) {
        try { await queueRef.current.refresh(); }
        catch { log('error', 'undo.refresh_failed', { count: record.removed.length }); }
      }
      if (!mounted.current) return;
      if (restoreArmed.length) setArmedIds(previous => new Set([...previous, ...restoreArmed]));
      setRemovalError(failed ? restored ? 'queueRestorePartialFailed' : 'queueRestoreFailed' : null);
      log(failed ? restored ? 'warn' : 'error' : 'info', 'undo.queue_restore_completed', {
        count: record.removed.length, restored, failed,
      });
      operationRef.current = false; setUndoing(false);
    })();
    return true;
  };
  return { queue, rows, message, selectedIds, armedIds, removing, removalError, allSelectedArmed,
    undoing, canRetryFailed, requestRetryFailed, failedIds, retryPriority, showArmedBadges: !retryPriority,
    cancelExport, canStart, requestStart, confirmation, cancelConfirmation, confirmExport,
    hasVisibleMutable: visualIds.length > 0, selectOnly, toggleSelection, extendRange, clear, selectAll, toggleArmed, removeSelected, undo };
}

export type ExportManagementState = ReturnType<typeof useExportManagement>;
