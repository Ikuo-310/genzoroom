import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dequeueExportAsset, enqueueExportAssets, listExportQueue,
  type ExportQueueApiError, type ExportQueueItem, type ExportQueueStatus,
} from './exportQueueApi';

export type ExportQueueMutation = 'enqueue' | 'dequeue';
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
  const mutationVersion = useRef(0);
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
    const versionAtStart = mutationVersion.current;
    if (mounted.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await listExportQueue(controller.signal);
      if (!mounted.current || controller.signal.aborted || generation !== loadGeneration.current) return;
      if (versionAtStart === mutationVersion.current) {
        setItems(result);
        setLoaded(true);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && generation === loadGeneration.current) {
        setError(cause);
      }
    } finally {
      activeControllers.current.delete(controller);
      if (loadController.current === controller) loadController.current = null;
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runMutation = useCallback(async (assetIds: readonly string[], operation: ExportQueueMutation, run: (signal: AbortSignal) => Promise<ExportQueueItem[] | void>) => {
    const keys = [...new Set(assetIds.map(keyOf))];
    if (keys.some(key => busyAssets.current.has(key))) throw new ExportQueueMutationBusyError();
    keys.forEach(key => busyAssets.current.add(key));
    setMutations(previous => {
      const next = new Map(previous);
      keys.forEach(key => next.set(key, { operation }));
      return next;
    });
    const controller = new AbortController();
    activeControllers.current.add(controller);
    const versionAtStart = mutationVersion.current;
    try {
      const response = await run(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const canonicalSnapshot = operation === 'enqueue' && response !== undefined
        && versionAtStart === mutationVersion.current;
      if (operation === 'enqueue' && response) {
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
      mutationVersion.current++;
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
      }
    }
  }, []);

  const enqueue = useCallback((assetIds: readonly string[]) => runMutation(
    assetIds, 'enqueue', signal => enqueueExportAssets(assetIds, signal),
  ), [runMutation]);
  const dequeue = useCallback((assetId: string) => runMutation(
    [assetId], 'dequeue', async signal => { await dequeueExportAsset(assetId, signal); },
  ), [runMutation]);

  const itemsByAssetId = indexItems(items);
  const getItem = useCallback((assetId: string) => itemsByAssetId.get(keyOf(assetId)), [itemsByAssetId]);
  const hasAsset = useCallback((assetId: string) => loaded ? itemsByAssetId.has(keyOf(assetId)) : undefined, [itemsByAssetId, loaded]);
  const getStatus = useCallback((assetId: string) => itemsByAssetId.get(keyOf(assetId))?.status, [itemsByAssetId]);
  const mutationFor = useCallback((assetId: string) => mutations.get(keyOf(assetId)) ?? { operation: null }, [mutations]);

  return { items, itemsByAssetId, getItem, hasAsset, getStatus, loaded, loading, error, refresh, enqueue, dequeue, mutationFor };
}
