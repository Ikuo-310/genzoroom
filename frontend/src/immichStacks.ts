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
