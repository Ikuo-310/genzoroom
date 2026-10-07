import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RecentAsset } from './assets';
import { ExportQueueApiError, type ExportQueueStatus } from './exportQueueApi';
import { flattenExportQueueDisplay, groupExportQueueAssets, uniqueExportQueueItems } from './exportQueueDisplay';
import { frontendLogger } from './frontendLogging';
import type { ExportQueueState } from './useExportQueue';
import { useExportQueueAssets } from './useExportQueueAssets';
import { usePhotoSelection } from './usePhotoSelection';
import { blurPhotoSelectionCheckboxWhenSelectionEnds } from './photoSelection';

export type ExportManagementQueue = Pick<ExportQueueState, 'items' | 'loaded' | 'loading' | 'error' | 'dequeue' | 'refresh' | 'mutationFor'>;
export const isMutableExportStatus = (status: ExportQueueStatus | undefined) => status === 'queued' || status === 'failed';
type RemovalError = 'locked' | 'removeFailed' | 'removePartialFailed';

function log(level: 'debug' | 'info' | 'warn' | 'error', event: string, context: Record<string, string | number>) {
  try { frontendLogger.add({ level, component: 'export_management', event, context }); }
  catch { /* Diagnostics must not change Queue removal outcomes. */ }
}

export function useExportManagement(queue: ExportManagementQueue, active: boolean) {
  const selection = usePhotoSelection();
  const [armedIds, setArmedIds] = useState<Set<string>>(() => new Set());
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState<RemovalError | null>(null);
  const removingRef = useRef(false);
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
  }, [mutableKey, selection.retainAvailable]);
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
  const canOperate = (id: string) => !removingRef.current && !message && mutable.has(id.toLowerCase())
    && !queue.mutationFor(id).operation;
  const selectOnly = (id: string) => { if (canOperate(id)) selection.selectOnly(id.toLowerCase()); };
  const toggleSelection = (id: string) => { if (canOperate(id)) selection.toggle(id.toLowerCase()); };
  const extendRange = (id: string) => { if (canOperate(id)) selection.extendRange(id.toLowerCase(), visualIds); };
  const clear = () => { if (!removingRef.current) selection.clear(); };
  const selectAll = () => {
    if (removingRef.current || !visualIds.length) return false;
    selection.selectVisible(visualIds.filter(id => !queue.mutationFor(id).operation));
    return true;
  };
  const toggleArmed = () => {
    if (removingRef.current || !selectedIds.length || message) return false;
    const targets = selectedIds.filter(id => !queue.mutationFor(id).operation);
    if (!targets.length) return false;
    setArmedIds(previous => {
      const next = new Set(previous);
      const turnOn = targets.some(id => !previous.has(id));
      targets.forEach(id => { if (turnOn) next.add(id); else next.delete(id); });
      return next;
    });
    return true;
  };
  const removeSelected = () => {
    if (removingRef.current || !selectedIds.length || message) return false;
    const selected = new Set(selectedIds);
    // Snapshot IDs in Queue order; selection changes cannot expand an in-flight batch.
    const targets = items.filter(item => selected.has(item.assetId.toLowerCase()) && !queue.mutationFor(item.assetId).operation)
      .map(item => item.assetId.toLowerCase());
    if (!targets.length) return false;
    removingRef.current = true;
    setRemoving(true); setRemovalError(null);
    log('debug', 'remove.started', { count: targets.length });
    void (async () => {
      let succeeded = 0, failed = 0, locked = 0;
      for (const assetId of targets) {
        if (!mounted.current) return;
        const current = queueRef.current.items.find(item => item.assetId.toLowerCase() === assetId);
        if (!current) continue;
        try {
          if (!isMutableExportStatus(current.status)) throw new ExportQueueApiError('locked');
          await queueRef.current.dequeue(assetId);
          succeeded++;
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
      log(failed ? succeeded ? 'warn' : 'error' : 'info', 'remove.completed', { count: targets.length, succeeded, failed, locked });
      removingRef.current = false; setRemoving(false);
    })();
    return true;
  };
  return { queue, rows, message, selectedIds, armedIds, removing, removalError, allSelectedArmed,
    hasVisibleMutable: visualIds.length > 0, selectOnly, toggleSelection, extendRange, clear, selectAll, toggleArmed, removeSelected };
}

export type ExportManagementState = ReturnType<typeof useExportManagement>;
