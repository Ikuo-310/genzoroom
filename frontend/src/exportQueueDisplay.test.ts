import { describe, expect, it } from 'vitest';
import { flattenExportQueueDisplay, groupExportQueueAssets, uniqueExportQueueItems, type ExportQueueAsset } from './exportQueueDisplay';

const entry = (id: string, stackId?: string): ExportQueueAsset => ({
  item: { assetId: id, status: 'failed', queuedAt: 'q', updatedAt: 'u' },
  asset: { id, filename: id, date: '', thumbnail_url: '', format: 'JPEG', is_raw: false, stackId, stackAssetCount: 100 },
});
describe('Export presentation grouping', () => {
  it('keeps unstacked and single queued Stack members standalone regardless of total Stack size', () => {
    expect(groupExportQueueAssets([entry('a'), entry('b', 'x')]).map(row => row.kind)).toEqual(['asset', 'asset']);
  });
  it.each([2, 3])('groups %i queued members in Queue order', count => {
    const entries = Array.from({ length: count }, (_, i) => entry(`${i}`, 'x'));
    expect(groupExportQueueAssets(entries)).toEqual([{ kind: 'stack', stackId: 'x', members: entries }]);
  });
  it('anchors noncontiguous groups at their first member without mutating the Queue', () => {
    const entries = [entry('a', 'x'), entry('b'), entry('c', 'y'), entry('d', 'x'), entry('e', 'y'), entry('f', 'z')];
    const original = structuredClone(entries);
    expect(groupExportQueueAssets(entries)).toEqual([
      { kind: 'stack', stackId: 'x', members: [entries[0], entries[3]] }, { kind: 'asset', entry: entries[1] },
      { kind: 'stack', stackId: 'y', members: [entries[2], entries[4]] }, { kind: 'asset', entry: entries[5] },
    ]);
    expect(entries).toEqual(original);
    expect(flattenExportQueueDisplay(groupExportQueueAssets(entries)).map(row => row.item.assetId)).toEqual(['a', 'd', 'b', 'c', 'e', 'f']);
  });
  it('deduplicates normalized IDs before counting Stack membership and preserves original statuses', () => {
    const entries = [entry('A', 'X'), entry('a', 'x'), entry('b', 'x')];
    expect(uniqueExportQueueItems(entries.map(row => row.item))).toEqual([entries[0].item, entries[2].item]);
    expect(groupExportQueueAssets(entries)).toEqual([{ kind: 'stack', stackId: 'X', members: [entries[0], entries[2]] }]);
    expect(groupExportQueueAssets(entries.slice(0, 2))).toEqual([{ kind: 'asset', entry: entries[0] }]);
  });
});
