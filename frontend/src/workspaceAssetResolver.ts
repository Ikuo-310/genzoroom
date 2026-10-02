import type { RecentAsset } from './assets';

export type WorkspaceAssetResolution =
  | { status: 'resolved'; asset: RecentAsset }
  | { status: 'unsupported' }
  | { status: 'ambiguous' };

export function resolveWorkspaceAsset(asset: RecentAsset, currentAssets: readonly RecentAsset[]): WorkspaceAssetResolution {
  if (!asset.stackId) return { status: 'resolved', asset };
  const candidates = currentAssets.filter(member => member.stackId === asset.stackId && member.is_raw === false);
  if (candidates.length === 0) return { status: 'unsupported' };
  if (candidates.length === 1) return { status: 'resolved', asset: candidates[0] };
  const primary = candidates.find(member => member.id === asset.primaryAssetId);
  return primary ? { status: 'resolved', asset: primary } : { status: 'ambiguous' };
}

export type WorkspaceAssetsResolution =
  | { status: 'resolved'; assets: RecentAsset[] }
  | { status: 'unsupported' }
  | { status: 'ambiguous' };

export function resolveWorkspaceAssets(selectedAssets: readonly RecentAsset[], currentAssets: readonly RecentAsset[]): WorkspaceAssetsResolution {
  const assets: RecentAsset[] = [];
  const seen = new Set<string>();
  for (const selected of selectedAssets) {
    const result = resolveWorkspaceAsset(selected, currentAssets);
    // Never open a partial selection when even one Stack cannot be resolved safely.
    if (result.status !== 'resolved') return result;
    if (!seen.has(result.asset.id)) {
      seen.add(result.asset.id);
      assets.push(result.asset);
    }
  }
  return { status: 'resolved', assets };
}
