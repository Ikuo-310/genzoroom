import type { AssetEditStatuses } from './editStatus';
import type { EditStatusFilterMode, StackFilterMode } from './photoFilters';
import type { RecentAsset } from './assets';

export function collapseImmichStacks(assets: readonly RecentAsset[]): RecentAsset[] {
  const groups = new Map<string, {
    primaryId: string;
    representative: RecentAsset;
    consistent: boolean;
  }>();
  for (const asset of assets) {
    if (!asset.stackId) continue;
    const group = groups.get(asset.stackId);
    if (!group) {
      groups.set(asset.stackId, {
        primaryId: asset.primaryAssetId ?? '',
        // Retain the first member as a fallback when the filtered set excludes the primary.
        representative: asset,
        consistent: !!asset.primaryAssetId,
      });
    } else {
      group.consistent &&= !!asset.primaryAssetId && asset.primaryAssetId === group.primaryId;
      if (asset.id === group.primaryId) group.representative = asset;
    }
  }

  const displayedStacks = new Set<string>();
  const displayAssets: RecentAsset[] = [];
  for (const asset of assets) {
    const group = asset.stackId ? groups.get(asset.stackId) : undefined;
    // Incomplete or conflicting metadata must not cause assets to disappear.
    if (!asset.stackId || !group?.consistent) {
      displayAssets.push(asset);
    } else if (!displayedStacks.has(asset.stackId)) {
      displayedStacks.add(asset.stackId);
      // Replace the first member's slot, preserving the stack's position in the input order.
      displayAssets.push(group.representative);
    }
  }
  return displayAssets;
}

export function filterImmichStacks(assets: RecentAsset[], mode: StackFilterMode): RecentAsset[] {
  if (mode === 'both') return assets;
  return assets.filter(asset => mode === 'stacked' ? !!asset.stackId : !asset.stackId);
}

export function stackEditStatusIds(assets: readonly RecentAsset[]): string[] {
  return [...new Set(assets.flatMap(asset => asset.stackId && asset.stackMemberIds?.length
    ? asset.stackMemberIds : [asset.id]))];
}

export function aggregateStackEditStatuses(assets: readonly RecentAsset[], statuses: AssetEditStatuses): AssetEditStatuses {
  const aggregated = { ...statuses };
  for (const asset of assets) {
    if (!asset.stackId || !asset.stackMemberIds?.length) continue;
    const values = asset.stackMemberIds.map(id => statuses[id]);
    // Home cards omit children; full snapshot IDs, rather than badge counts, establish edit completeness.
    aggregated[asset.id] = values.some(value => value === true) ? true
      : values.some(value => value === undefined) ? undefined : false;
  }
  return aggregated;
}

export function filterImmichStacksByEditStatus(
  assets: RecentAsset[], mode: EditStatusFilterMode, statuses: AssetEditStatuses,
): RecentAsset[] {
  if (mode === 'both') return assets;
  const aggregated = aggregateStackEditStatuses(assets, statuses);
  const groups = new Map<string, { edited: boolean; unknown: boolean; ids: Set<string>; total: number }>();
  for (const asset of assets) {
    if (!asset.stackId) continue;
    const group = groups.get(asset.stackId) ?? { edited: false, unknown: false, ids: new Set<string>(), total: 0 };
    group.edited ||= statuses[asset.id] === true;
    group.unknown ||= statuses[asset.id] === undefined;
    group.ids.add(asset.id);
    group.total = Math.max(group.total, asset.stackAssetCount ?? 0);
    groups.set(asset.stackId, group);
  }
  return assets.filter(asset => {
    let status = statuses[asset.id];
    if (asset.stackId && asset.stackMemberIds?.length) {
      status = aggregated[asset.id];
    } else if (asset.stackId) {
      const group = groups.get(asset.stackId)!;
      // Album/day results may omit members; absence cannot establish that the whole stack is unedited.
      status = group.edited ? true : group.unknown || group.total > group.ids.size ? undefined : false;
    }
    return status === undefined || (mode === 'edited' ? status : !status);
  });
}
