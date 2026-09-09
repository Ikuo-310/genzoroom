import type { RecentAsset, WorkspaceNavigationState } from './assets';

export function toggleSelectedAssetId(selectedIds: string[], assetId: string): string[] {
  return selectedIds.includes(assetId)
    ? selectedIds.filter((id) => id !== assetId)
    : [...selectedIds, assetId];
}

export function resolveSelectedAssets(assets: RecentAsset[], selectedIds: string[]): RecentAsset[] {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  // Resolve in ID selection order rather than gallery or filter order.
  return selectedIds.flatMap((id) => {
    const asset = assetsById.get(id);
    return asset ? [asset] : [];
  });
}

export function createWorkspaceNavigation(selectedAssets: RecentAsset[]): WorkspaceNavigationState | null {
  const firstAsset = selectedAssets[0];
  return firstAsset ? { selectedAssets, activeAssetId: firstAsset.id } : null;
}

export function activateWorkspaceAsset(
  state: WorkspaceNavigationState,
  activeAssetId: string,
): WorkspaceNavigationState {
  return state.selectedAssets.some((asset) => asset.id === activeAssetId)
    ? { selectedAssets: state.selectedAssets, activeAssetId }
    : state;
}

export function workspacePath(assetId: string): string {
  return `/anshitsu/${assetId}`;
}

type KeyboardEventDetails = {
  key: string;
  defaultPrevented: boolean;
  target: EventTarget | null;
};

export function shouldClearSelectionOnEscape(event: KeyboardEventDetails, hasSelection: boolean): boolean {
  if (!hasSelection || event.defaultPrevented || event.key !== 'Escape') return false;

  const target = event.target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  const tagName = target?.tagName?.toUpperCase();
  if (target?.isContentEditable || tagName === 'SELECT' || tagName === 'TEXTAREA') return false;

  if (tagName === 'INPUT') {
    const inputType = target?.type?.toLowerCase() || 'text';
    return inputType === 'checkbox' || inputType === 'radio' || inputType === 'button'
      || inputType === 'submit' || inputType === 'reset';
  }

  return true;
}
