import { describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import {
  activateWorkspaceAsset,
  createWorkspaceNavigation,
  resolveSelectedAssets,
  toggleSelectedAssetId,
  workspacePath,
} from './photoSelection';

const assets: RecentAsset[] = [
  { id: 'a', filename: 'a.jpg', date: '2026-01-01', thumbnail_url: '/a', format: 'JPEG', is_raw: false },
  { id: 'b', filename: 'b.dng', date: '2026-01-02', thumbnail_url: '/b', format: 'DNG', is_raw: true },
  { id: 'c', filename: 'c.heic', date: '2026-01-03', thumbnail_url: '/c', format: 'HEIC', is_raw: false },
];

describe('photo selection', () => {
  it('starts selection mode, supports multiple unique IDs, and preserves selection order', () => {
    let selectedIds: string[] = [];
    selectedIds = toggleSelectedAssetId(selectedIds, 'b');
    selectedIds = toggleSelectedAssetId(selectedIds, 'a');
    expect(selectedIds).toEqual(['b', 'a']);
    expect(resolveSelectedAssets(assets, selectedIds).map((asset) => asset.id)).toEqual(['b', 'a']);
  });

  it('removes selected IDs and returns to an empty normal state after all are cleared', () => {
    expect(toggleSelectedAssetId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleSelectedAssetId(['b'], 'b')).toEqual([]);
  });

  it('resolves selection from the full fetched list regardless of a visible filtered list', () => {
    const visibleRawAssets = assets.filter((asset) => asset.is_raw);
    expect(visibleRawAssets.map((asset) => asset.id)).toEqual(['b']);
    expect(resolveSelectedAssets(assets, ['a', 'b']).map((asset) => asset.id)).toEqual(['a', 'b']);
  });

  it('opens the first selected asset and preserves the group when active asset changes', () => {
    const state = createWorkspaceNavigation(resolveSelectedAssets(assets, ['b', 'a']));
    expect(state?.activeAssetId).toBe('b');
    expect(workspacePath(state!.activeAssetId)).toBe('/anshitsu/b');

    const switched = activateWorkspaceAsset(state!, 'a');
    expect(switched.activeAssetId).toBe('a');
    expect(switched.selectedAssets).toBe(state!.selectedAssets);
  });

  it('does not create a workspace state without a selection', () => {
    expect(createWorkspaceNavigation([])).toBeNull();
  });
});
