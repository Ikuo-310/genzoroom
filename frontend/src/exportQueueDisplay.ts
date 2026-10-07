import type { RecentAsset } from './assets';
import type { ExportQueueItem } from './exportQueueApi';

export type ExportQueueAsset = { item: ExportQueueItem; asset: RecentAsset };
export type ExportQueueDisplayItem =
  | { kind: 'asset'; entry: ExportQueueAsset }
  | { kind: 'stack'; stackId: string; members: ExportQueueAsset[] };

export function flattenExportQueueDisplay(rows: readonly ExportQueueDisplayItem[]): ExportQueueAsset[] {
  return rows.flatMap(row => row.kind === 'asset' ? [row.entry] : row.members);
}

export function uniqueExportQueueItems(items: readonly ExportQueueItem[]): ExportQueueItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.assetId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupExportQueueAssets(entries: readonly ExportQueueAsset[]): ExportQueueDisplayItem[] {
  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    const key = entry.item.assetId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const counts = new Map<string, number>();
  for (const { asset } of unique) {
    if (asset.stackId) {
      const key = asset.stackId.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const groups = new Map<string, Extract<ExportQueueDisplayItem, { kind: 'stack' }>>();
  const result: ExportQueueDisplayItem[] = [];
  for (const entry of unique) {
    const stackId = entry.asset.stackId;
    const key = stackId?.toLowerCase();
    if (!stackId || !key || (counts.get(key) ?? 0) < 2) {
      result.push({ kind: 'asset', entry });
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { kind: 'stack', stackId, members: [] };
      groups.set(key, group);
      // The first queued member fixes group position; later members only append inside it.
      result.push(group);
    }
    group.members.push(entry);
  }
  return result;
}
