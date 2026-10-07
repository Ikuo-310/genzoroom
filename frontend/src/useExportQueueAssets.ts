import { useEffect, useRef, useState } from 'react';
import { fetchAssetDetail, refreshSelectedImmichStacks } from './api';
import type { RecentAsset } from './assets';
import type { ExportQueueItem } from './exportQueueApi';
import { uniqueExportQueueItems } from './exportQueueDisplay';
import { frontendLogger, type FrontendLogInput } from './frontendLogging';

const DETAIL_CONCURRENCY = 4;
type MetadataSnapshot = { key: string; status: 'loading' | 'ready' | 'error'; assets: RecentAsset[] };
function log(input: Omit<FrontendLogInput, 'component'>) {
  try { frontendLogger.add({ ...input, component: 'export_metadata' }); }
  catch { /* Diagnostics must never change metadata resolution. */ }
}

export function useExportQueueAssets(items: readonly ExportQueueItem[], loaded: boolean) {
  // Status-only updates and refreshes must not restart detail requests or clear valid cards.
  const idsKey = JSON.stringify(uniqueExportQueueItems(items).map(item => item.assetId.toLowerCase()));
  const [snapshot, setSnapshot] = useState<MetadataSnapshot>({ key: '', status: 'loading', assets: [] });
  const generationRef = useRef(0);

  useEffect(() => {
    if (!loaded) return;
    const ids = JSON.parse(idsKey) as string[];
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && generationRef.current === generation;
    if (!ids.length) {
      setSnapshot({ key: idsKey, status: 'ready', assets: [] });
      return;
    }
    setSnapshot({ key: idsKey, status: 'loading', assets: [] });
    log({ level: 'debug', event: 'resolve.started', context: { generation, count: ids.length, concurrency: DETAIL_CONCURRENCY } });
    const assets = new Array<RecentAsset>(ids.length);
    let nextIndex = 0;
    let failureCount = 0;
    const worker = async () => {
      while (isCurrent() && nextIndex < ids.length) {
        const index = nextIndex++;
        const assetId = ids[index];
        try {
          const detail = await fetchAssetDetail(assetId, controller.signal);
          if (!isCurrent()) return;
          if (detail.id.toLowerCase() !== assetId) {
            log({ level: 'warn', event: 'validation.mismatch', context: { generation, assetId, actualAssetId: detail.id } });
            throw new Error('Asset detail ID mismatch');
          }
          // Keep only card metadata; preview and EXIF remain owned by the detail/workspace path.
          assets[index] = { id: detail.id, filename: detail.filename, date: detail.date,
            thumbnail_url: detail.thumbnail_url, format: detail.format, is_raw: detail.is_raw };
        } catch {
          if (!isCurrent()) return;
          failureCount++;
          log({ level: 'debug', event: 'detail.failed', context: { generation, assetId } });
        }
      }
    };
    void Promise.all([
      Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker)),
      refreshSelectedImmichStacks(ids, controller.signal),
    ]).then(([, stacks]) => {
      // Abort is advisory: late transports must never publish an older Queue generation.
      if (!isCurrent()) return;
      const stackByMemberId = new Map(stacks.flatMap(stack => stack.assets.map(member => [member.id.toLowerCase(), {
        stackId: stack.id, primaryAssetId: stack.primaryAssetId, stackAssetCount: stack.assets.length,
      }] as const)));
      const joinedAssets = assets.map(asset => {
        const membership = stackByMemberId.get(asset.id.toLowerCase());
        return membership ? { ...asset, ...membership } : asset;
      });
      setSnapshot({ key: idsKey, status: failureCount ? 'error' : 'ready', assets: failureCount ? [] : joinedAssets });
      log({ level: failureCount ? 'error' : 'info', event: failureCount ? 'resolve.failed' : 'resolve.completed',
        context: { generation, count: ids.length, failureCount } });
    }).catch(error => {
      if (!isCurrent()) return;
      log({ level: 'error', event: 'stack_membership.failed', context: { generation, count: ids.length,
        errorCode: error instanceof Error ? error.name : 'operation_failed' } });
      setSnapshot({ key: idsKey, status: 'error', assets: [] });
      controller.abort();
    });
    return () => {
      controller.abort();
      generationRef.current++;
      log({ level: 'debug', event: 'resolve.aborted', context: { generation } });
    };
  }, [idsKey, loaded]);

  // Hide preceding IDs immediately, including the render before effect cleanup runs.
  return snapshot.key === idsKey ? snapshot : { key: idsKey, status: 'loading' as const, assets: [] };
}
