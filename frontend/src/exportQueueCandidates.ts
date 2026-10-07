import { fetchAssetDetail } from './api';
import type { AssetDetail, RecentAsset } from './assets';
import type { ExportQueueItem } from './exportQueueApi';

export const MAX_EXPORT_ENGINE_CANDIDATES = 10;
export type QueueAssetDetail = (assetId: string, signal: AbortSignal) => Promise<AssetDetail>;

export async function resolveExportQueueCandidates(items: readonly ExportQueueItem[], signal: AbortSignal,
  getDetail: QueueAssetDetail = fetchAssetDetail): Promise<RecentAsset[]> {
  const candidates: RecentAsset[] = [];
  let resolved = 0, failed = 0;
  for (const item of items) {
    if (candidates.length >= MAX_EXPORT_ENGINE_CANDIDATES) break;
    signal.throwIfAborted();
    try {
      const detail = await getDetail(item.assetId, signal);
      resolved++;
      if (detail.id === item.assetId && detail.format === 'JPEG' && !detail.is_raw) candidates.push(detail);
    } catch (error) {
      if (signal.aborted) throw error;
      failed++;
    }
  }
  if (items.length > 0 && resolved === 0 && failed > 0) throw new Error('queue_candidate_load_failed');
  return candidates;
}
