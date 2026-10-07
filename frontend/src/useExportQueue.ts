import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dequeueExportAsset, enqueueExportAssets, listExportQueue, retryExportAssets,
  type ExportQueueApiError, type ExportQueueItem, type ExportQueueStatus,
} from './exportQueueApi';
import { useExportRuntime } from './useExportRuntime';

export type ExportQueueMutation = 'enqueue' | 'dequeue' | 'retry';
export type ExportQueueMutationState = { operation: ExportQueueMutation | null; error?: unknown };

export type ExportQueueState = {
  items: ExportQueueItem[];
  itemsByAssetId: ReadonlyMap<string, ExportQueueItem>;
  getItem: (assetId: string) => ExportQueueItem | undefined;
  hasAsset: (assetId: string) => boolean | undefined;
  getStatus: (assetId: string) => ExportQueueStatus | undefined;
  loaded: boolean;
  loading: boolean;
  error: ExportQueueApiError | unknown | null;
  refresh: () => Promise<void>;
  enqueue: (assetIds: readonly string[]) => Promise<void>;
  dequeue: (assetId: string) => Promise<void>;
  retry: (assetIds: readonly string[]) => Promise<void>;
  runtime: ReturnType<typeof useExportRuntime>['runtime'];
  cancelRuntime: ReturnType<typeof useExportRuntime>['cancel'];
  cancelling: boolean;
  starting: boolean;
  startRuntime: ReturnType<typeof useExportRuntime>['start'];
  mutationFor: (assetId: string) => ExportQueueMutationState;
};

const keyOf = (assetId: string) => assetId.toLowerCase();
const indexItems = (items: ExportQueueItem[]) => new Map(items.map(item => [keyOf(item.assetId), item]));

export class ExportQueueMutationBusyError extends Error {
  constructor() {
    super('An Export Queue mutation is already running for this asset.');
  }
}

export function useExportQueue(): ExportQueueState {
  const [items, setItems] = useState<ExportQueueItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ExportQueueApiError | unknown | null>(null);
  const [mutations, setMutations] = useState<Map<string, ExportQueueMutationState>>(() => new Map());
  const mounted = useRef(false);
  const activeControllers = useRef(new Set<AbortController>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  const mutationStartGeneration = useRef(0);
  const refreshStartGeneration = useRef(0);
  const refreshPending = useRef(false);
  const busyAssets = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current++;
      for (const controller of activeControllers.current) controller.abort();
      activeControllers.current.clear();
      loadController.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    activeControllers.current.add(controller);
    loadController.current = controller;
    const generation = ++loadGeneration.current;
    refreshStartGeneration.current++;
    const snapshotAtStart = snapshotGeneration.current;
    const mutationsAtStart = mutationStartGeneration.current;
    if (mounted.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await listExportQueue(controller.signal);
      if (!mounted.current || controller.signal.aborted || generation !== loadGeneration.current) return;
      if (snapshotAtStart === snapshotGeneration.current
        && mutationsAtStart === mutationStartGeneration.current && busyAssets.current.size === 0) {
        setItems(result);
        setLoaded(true);
        setError(null);
        snapshotGeneration.current++;
        refreshPending.current = false;
      } else {
        // A GET racing a mutation may predate its commit; retry after mutations settle.
        refreshPending.current = true;
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && generation === loadGeneration.current) {
        setError(cause);
      }
    } finally {
      activeControllers.current.delete(controller);
      if (loadController.current === controller) loadController.current = null;
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
      if (mounted.current && refreshPending.current && busyAssets.current.size === 0) {
        refreshPending.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runMutation = useCallback(async (assetIds: readonly string[], operation: ExportQueueMutation, run: (signal: AbortSignal) => Promise<ExportQueueItem[] | void>) => {
    const keys = [...new Set(assetIds.map(keyOf))];
    if (keys.some(key => busyAssets.current.has(key))) throw new ExportQueueMutationBusyError();
    keys.forEach(key => busyAssets.current.add(key));
    const snapshotAtStart = snapshotGeneration.current;
    const mutationsAtStart = mutationStartGeneration.current++;
    const refreshesAtStart = refreshStartGeneration.current;
    setMutations(previous => {
      const next = new Map(previous);
      keys.forEach(key => next.set(key, { operation }));
      return next;
    });
    const controller = new AbortController();
    activeControllers.current.add(controller);
    try {
      const response = await run(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const canonicalSnapshot = operation !== 'dequeue' && response !== undefined
        && snapshotAtStart === snapshotGeneration.current
        && mutationsAtStart === mutationStartGeneration.current - 1
        && refreshesAtStart === refreshStartGeneration.current;
      if (operation !== 'dequeue' && response) {
        if (canonicalSnapshot) {
          setItems(response);
        } else {
          const responseById = indexItems(response);
          setItems(previous => {
            const existingKeys = new Set(previous.map(item => keyOf(item.assetId)));
            const next = previous.map(item => keys.includes(keyOf(item.assetId))
              ? responseById.get(keyOf(item.assetId)) ?? item
              : item);
            for (const item of response) {
              const key = keyOf(item.assetId);
              if (keys.includes(key) && !existingKeys.has(key)) next.push(item);
            }
            return next;
          });
        }
      } else if (operation === 'dequeue') {
        setItems(previous => previous.filter(item => !keys.includes(keyOf(item.assetId))));
      }
      snapshotGeneration.current++;
      if (canonicalSnapshot) setLoaded(true);
      setError(null);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setMutations(previous => {
          const next = new Map(previous);
          keys.forEach(key => next.set(key, { operation: null, error: cause }));
          return next;
        });
      }
      throw cause;
    } finally {
      activeControllers.current.delete(controller);
      keys.forEach(key => busyAssets.current.delete(key));
      if (mounted.current) {
        setMutations(previous => {
          const next = new Map(previous);
          keys.forEach(key => {
            const current = next.get(key);
            if (current?.operation === operation) next.set(key, { operation: null, ...(current.error ? { error: current.error } : {}) });
          });
          return next;
        });
        if (refreshPending.current && busyAssets.current.size === 0) {
          refreshPending.current = false;
          void refresh();
        }
      }
    }
  }, [refresh]);

  const enqueue = useCallback((assetIds: readonly string[]) => runMutation(
    assetIds, 'enqueue', signal => enqueueExportAssets(assetIds, signal),
  ), [runMutation]);
  const dequeue = useCallback((assetId: string) => runMutation(
    [assetId], 'dequeue', async signal => { await dequeueExportAsset(assetId, signal); },
  ), [runMutation]);
  const retry = useCallback(async (assetIds: readonly string[]) => {
    try { await runMutation(assetIds, 'retry', signal => retryExportAssets(assetIds, signal)); }
    finally { await refresh(); }
  }, [runMutation, refresh]);
  const { runtime, cancel: cancelRuntime, cancelling, start: startRuntime, starting } = useExportRuntime(refresh);

  const itemsByAssetId = indexItems(items);
  const getItem = useCallback((assetId: string) => itemsByAssetId.get(keyOf(assetId)), [itemsByAssetId]);
  const hasAsset = useCallback((assetId: string) => loaded ? itemsByAssetId.has(keyOf(assetId)) : undefined, [itemsByAssetId, loaded]);
  const getStatus = useCallback((assetId: string) => itemsByAssetId.get(keyOf(assetId))?.status, [itemsByAssetId]);
  const mutationFor = useCallback((assetId: string) => mutations.get(keyOf(assetId)) ?? { operation: null }, [mutations]);

  return { items, itemsByAssetId, getItem, hasAsset, getStatus, loaded, loading, error, refresh, enqueue, dequeue, retry, runtime, cancelRuntime, cancelling, startRuntime, starting, mutationFor };
}
