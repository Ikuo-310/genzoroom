import type { RecentAsset } from './assets';
import type { AnshitsuInitialSelection } from './appSettings';
import { resolveGalleryStackSelection } from './useGalleryStackSelections';

export type WorkspaceAssetsResolution =
  | { status: 'resolved'; assets: RecentAsset[] }
  | { status: 'unavailable' }
  | { status: 'empty' };

export function resolveWorkspaceAssets(selectedAssets: readonly RecentAsset[], preset: AnshitsuInitialSelection): WorkspaceAssetsResolution {
  const assets: RecentAsset[] = [];
  const seen = new Set<string>();
  for (const selected of selectedAssets) {
    // Direct assets keep their existing semantics; only Stack cards consult presets and manual overrides.
    const result = selected.stackId == null
      ? { status: 'ready' as const, assets: [selected] }
      : resolveGalleryStackSelection(selected, preset);
    // An incomplete Stack must never open a partial Filmstrip or fall back to a remembered workspace.
    if (result.status !== 'ready') return { status: 'unavailable' };
    for (const asset of result.assets) {
      const id = asset.id.toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        assets.push(asset);
      }
    }
  }
  return assets.length > 0 ? { status: 'resolved', assets } : { status: 'empty' };
}
