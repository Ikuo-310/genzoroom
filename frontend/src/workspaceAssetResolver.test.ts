import { beforeEach, describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { resolveWorkspaceAssets } from './workspaceAssetResolver';
import { makeGalleryStack } from './gallerySelectionTestHelpers';
import { restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection } from './useGalleryStackSelections';

const single = (id: string, format = 'JPEG', exported = false): RecentAsset => ({
  id, filename: `${id}.${format}`, format, is_raw: format === 'DNG', isGenzoRoomExport: exported,
  date: '2026-09-01', thumbnail_url: `/thumb/${id}`,
});
beforeEach(() => restoreGalleryStackSelectionsFromSession());

describe('workspace Asset expansion', () => {
  it.each(['JPEG', 'PNG', 'DNG'])('passes unstacked %s directly, even when exported', format => {
    const photo = single('plain', format, true);
    expect(resolveWorkspaceAssets([photo], 'nonRaw')).toEqual({ status: 'resolved', assets: [photo] });
  });
  it('expands every unexported JPEG and PNG without preferring the cover', () => {
    const stack = makeGalleryStack(1, ['JPEG', 'JPEG', 'PNG', 'DNG'], [0]);
    expect(resolveWorkspaceAssets([stack], 'nonRaw')).toEqual({ status: 'resolved', assets: stack.stackMembers!.slice(1, 3) });
  });
  it('falls back to every RAW in a RAW-only Stack', () => {
    const stack = makeGalleryStack(1, ['DNG', 'DNG']);
    expect(resolveWorkspaceAssets([stack], 'nonRaw')).toEqual({ status: 'resolved', assets: stack.stackMembers });
  });
  it('preserves card selection order and member snapshot order, deduplicating at the first position', () => {
    const a = makeGalleryStack(1, ['DNG', 'JPEG', 'PNG']);
    const b = makeGalleryStack(2, ['DNG', 'DNG']);
    const png = single('plain', 'PNG');
    const duplicateDirect = { ...a.stackMembers![1], stackId: null, primaryAssetId: null };
    expect(resolveWorkspaceAssets([a, png, b, a, duplicateDirect], 'both')).toEqual({
      status: 'resolved', assets: [...a.stackMembers!, png, ...b.stackMembers!],
    });
  });
  it('deduplicates Asset UUID casing while retaining the first object', () => {
    const id = '12345678-1234-4234-9234-123456789abc';
    const first = single(id.toUpperCase());
    expect(resolveWorkspaceAssets([first, single(id)], 'nonRaw')).toEqual({ status: 'resolved', assets: [first] });
  });
  it('skips ready empty Stacks, but returns empty if no targets remain', () => {
    const exported = makeGalleryStack(1, ['JPEG', 'DNG'], [0, 1]);
    const photo = single('plain');
    expect(resolveWorkspaceAssets([exported], 'nonRaw')).toEqual({ status: 'empty' });
    expect(resolveWorkspaceAssets([exported, photo], 'nonRaw')).toEqual({ status: 'resolved', assets: [photo] });
  });
  it.each([undefined, null])('rejects an unavailable Stack atomically, even beside valid direct assets (%s)', stackMembers => {
    const stack = { ...makeGalleryStack(1, ['JPEG', 'DNG']), stackMembers };
    expect(resolveWorkspaceAssets([single('plain'), stack], 'nonRaw')).toEqual({ status: 'unavailable' });
  });
  it('honors manual RAW selection and manual all-off without preset fallback', () => {
    const stack = makeGalleryStack(1, ['JPEG', 'DNG']);
    setManualGalleryStackSelection(stack, new Set([stack.stackMembers![1].id]));
    expect(resolveWorkspaceAssets([stack], 'nonRaw')).toEqual({ status: 'resolved', assets: [stack.stackMembers![1]] });
    setManualGalleryStackSelection(stack, new Set());
    expect(resolveWorkspaceAssets([stack], 'nonRaw')).toEqual({ status: 'empty' });
  });
});
