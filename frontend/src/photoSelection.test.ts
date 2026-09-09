import { describe, expect, it, vi } from 'vitest';
import type { RecentAsset } from './assets';
import {
  activateWorkspaceAsset,
  blurPhotoSelectionCheckboxWhenSelectionEnds,
  createWorkspaceNavigation,
  resolveSelectedAssets,
  shouldClearSelectionOnEscape,
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

  it('clears a non-empty selection with Escape', () => {
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target: null }, true)).toBe(true);
  });

  it('does nothing with Escape when no photos are selected', () => {
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target: null }, false)).toBe(false);
  });

  it('clears selection immediately after a photo checkbox receives focus', () => {
    const target = { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget;
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target }, true)).toBe(true);
  });

  it('clears selection while a button has focus', () => {
    const target = { tagName: 'BUTTON' } as unknown as EventTarget;
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target }, true)).toBe(true);
  });

  it.each(['text', 'search', 'number', 'email'])('does not clear selection while a %s input is being edited', (type) => {
    const target = { tagName: 'INPUT', type } as unknown as EventTarget;
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target }, true)).toBe(false);
  });

  it.each(['TEXTAREA', 'SELECT'])('does not clear selection while %s has focus', (tagName) => {
    const target = { tagName } as unknown as EventTarget;
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target }, true)).toBe(false);
  });

  it('does not clear selection while contenteditable content has focus', () => {
    const target = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    expect(shouldClearSelectionOnEscape({ key: 'Escape', defaultPrevented: false, target }, true)).toBe(false);
  });

  it('removes focus from the photo selection checkbox when selection mode ends', () => {
    const blur = vi.fn();
    const element = { classList: { contains: (name: string) => name === 'photo-selection-input' }, blur };

    expect(blurPhotoSelectionCheckboxWhenSelectionEnds(element, true, false)).toBe(true);
    expect(blur).toHaveBeenCalledOnce();
  });

  it('keeps photo selection focus while selection mode remains active', () => {
    const blur = vi.fn();
    const element = { classList: { contains: (name: string) => name === 'photo-selection-input' }, blur };

    expect(blurPhotoSelectionCheckboxWhenSelectionEnds(element, true, true)).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });

  it('does not blur unrelated controls when selection mode exits', () => {
    const blur = vi.fn();
    const rawFilter = { classList: { contains: () => false }, blur };

    expect(blurPhotoSelectionCheckboxWhenSelectionEnds(rawFilter, true, false)).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });
});
