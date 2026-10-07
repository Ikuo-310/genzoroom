import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RecentAsset } from './assets';
import { ExportQueueApiError, type ExportQueueStatus } from './exportQueueApi';
import { flattenExportQueueDisplay, groupExportQueueAssets, uniqueExportQueueItems } from './exportQueueDisplay';
import { frontendLogger } from './frontendLogging';
import type { ExportQueueState } from './useExportQueue';
import { useExportQueueAssets } from './useExportQueueAssets';
import { usePhotoSelection } from './usePhotoSelection';
import { blurPhotoSelectionCheckboxWhenSelectionEnds } from './photoSelection';

export type ExportManagementQueue = Pick<ExportQueueState, 'items' | 'loaded' | 'loading' | 'error' | 'enqueue' | 'dequeue' | 'refresh' | 'mutationFor'>
  & Partial<Pick<ExportQueueState, 'retry' | 'runtime' | 'cancelRuntime' | 'cancelling'>>;
export const isMutableExportStatus = (status: ExportQueueStatus | undefined) => status === 'queued' || status === 'failed';
type ManagementError = 'locked' | 'removeFailed' | 'removePartialFailed' | 'queueRestoreFailed' | 'queueRestorePartialFailed' | 'retryFailed' | 'cancelFailed';
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
  const operationRef = useRef(false);
  const undoRecord = useRef<ExportUndoRecord | null>(null);
  const [undoing, setUndoing] = useState(false);
  const mounted = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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
  const message = queue.error ? 'queueLoadFailed' : !queue.loaded ? 'queueLoading' : !items.length ? 'empty'
    : metadata.status === 'error' ? 'metadataLoadFailed' : resolvedAssets.length ? null : 'metadataLoading';
  const entries = items.flatMap(item => {
    const asset = assetsById.get(item.assetId.toLowerCase());
    return asset ? [{ item, asset }] : [];
  });
  const rows = groupExportQueueAssets(entries);
  const mutableIds = items.filter(item => isMutableExportStatus(item.status)).map(item => item.assetId.toLowerCase());
  const mutableKey = JSON.stringify(mutableIds);
  useEffect(() => {
    const available = new Set<string>(JSON.parse(mutableKey));
    selection.retainAvailable(available);
    setArmedIds(previous => {
      const next = new Set([...previous].filter(id => available.has(id)));
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
  }, [mutableKey, selection.retainAvailable, removing, undoing]);
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
    .filter(entry => isMutableExportStatus(entry.item.status)).map(entry => entry.item.assetId.toLowerCase());
  const allSelectedArmed = selectedIds.length > 0 && selectedIds.every(id => armedIds.has(id));
  const canRetry = !!queue.retry && selectedIds.length > 0 && selectedIds.length <= 100 && !message
    && selectedIds.every(id => items.find(item => item.assetId.toLowerCase() === id)?.status === 'failed'
      && !queue.mutationFor(id).operation);
  const retrySelected = () => {
    if (operationRef.current || !canRetry) return false;
    operationRef.current = true; setRemoving(true); setRemovalError(null);
    const targets = [...selectedIds];
    // Retry is new Queue intent, never an inverse operation in W/Q Undo.
    void (async () => {
      try {
        await queueRef.current.retry!(targets);
        log('info', 'retry.completed', { count: targets.length });
      } catch {
        if (mounted.current) setRemovalError('retryFailed');
        log('error', 'retry.failed', { count: targets.length });
      } finally {
        if (mounted.current) { operationRef.current = false; setRemoving(false); }
      }
    })();
    return true;
  };
  const cancelExport = () => {
    if (operationRef.current || !queue.runtime?.stopAllowed || queue.cancelling || !queue.cancelRuntime) return false;
    operationRef.current = true; setRemoving(true); setRemovalError(null);
    void (async () => {
      try { await queueRef.current.cancelRuntime!(); log('info', 'run.stopRequested', {}); }
      catch { if (mounted.current) setRemovalError('cancelFailed'); log('error', 'run.stopRequestFailed', {}); }
      finally { if (mounted.current) { operationRef.current = false; setRemoving(false); } }
    })();
    return true;
  };
  const canOperate = (id: string) => !operationRef.current && !message && mutable.has(id.toLowerCase())
    && !queue.mutationFor(id).operation;
  const selectOnly = (id: string) => { if (canOperate(id)) selection.selectOnly(id.toLowerCase()); };
  const toggleSelection = (id: string) => { if (canOperate(id)) selection.toggle(id.toLowerCase()); };
  const extendRange = (id: string) => { if (canOperate(id)) selection.extendRange(id.toLowerCase(), visualIds); };
  const clear = () => { if (!operationRef.current) selection.clear(); };
  const selectAll = () => {
    if (operationRef.current || !visualIds.length) return false;
    selection.selectVisible(visualIds.filter(id => !queue.mutationFor(id).operation));
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
    if (operationRef.current || !selectedIds.length || message) return false;
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
      let succeeded = 0, failed = 0, locked = 0;
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
        }
      }
      if (!mounted.current) return;
      if (failed) {
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
      let restored = 0, failed = 0;
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
        } catch {
          failed++;
        }
      }
      if (!mounted.current) return;
      if (failed) {
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
    undoing, canRetry, retrySelected, cancelExport, hasVisibleMutable: visualIds.length > 0, selectOnly, toggleSelection, extendRange, clear, selectAll, toggleArmed, removeSelected, undo };
}

export type ExportManagementState = ReturnType<typeof useExportManagement>;
