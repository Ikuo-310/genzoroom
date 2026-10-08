import { describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { galleryStacksById } from './assets';
import { selectGalleryAssetTargets, selectGalleryStackTargets } from './galleryAssetSelection';

const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const stackId = '10000000-0000-4000-8000-000000000001';
function member(index: number, filename: string, raw: boolean, exported = false): RecentAsset {
  return { id: ids[index], filename, date: '2026-10-01', thumbnail_url: `/thumb/${index}`,
    format: filename.split('.').at(-1)!.toUpperCase(), is_raw: raw, isGenzoRoomExport: exported,
    stackId, primaryAssetId: ids[0], stackAssetCount: 3 };
}
function card(members: RecentAsset[]): RecentAsset {
  const normalized = members.map(item => ({ ...item, stackAssetCount: members.length }));
  return { ...normalized[0], stackMemberIds: normalized.map(item => item.id), stackMembers: normalized };
}
const idsOf = (result: ReturnType<typeof selectGalleryAssetTargets>) => [...result.selectedAssetIds].sort();

describe('Gallery asset targets', () => {
  it('selects every eligible non-RAW file, including PNGs, and excludes tagged members individually', () => {
    const stack = card([member(0, 'cover.jpg', false), member(1, 'second.jpeg', false), member(2, 'output.png', false, true)]);
    const result = selectGalleryAssetTargets(stack, 'nonRaw');
    expect(result.status).toBe('ready');
    expect(idsOf(result)).toEqual(ids.slice(0, 2).sort());
    expect(result.assets!.map(asset => asset.filename)).toEqual(['cover.jpg', 'second.jpeg']);
  });

  it('selects RAW and Both presets, and falls back to the other type only when needed', () => {
    const mixed = card([member(0, 'cover.jpg', false), member(1, 'raw.dng', true), member(2, 'png.png', false)]);
    expect(idsOf(selectGalleryAssetTargets(mixed, 'raw'))).toEqual([ids[1]]);
    expect(idsOf(selectGalleryAssetTargets(mixed, 'both'))).toEqual([ids[0], ids[1], ids[2]].sort());
    const raws = card([member(0, 'cover.dng', true), member(1, 'second.dng', true), member(2, 'export.jpg', false, true)]);
    expect(idsOf(selectGalleryAssetTargets(raws, 'nonRaw'))).toEqual([ids[0], ids[1]].sort());
    const nonRaws = card([member(0, 'cover.jpg', false), member(1, 'output.dng', true, true)]);
    expect(idsOf(selectGalleryAssetTargets(nonRaws, 'raw'))).toEqual([ids[0]]);
  });

  it('keeps COVER status independent and distinguishes no candidates from unavailable data', () => {
    const coverExported = card([member(0, 'cover.jpg', false, true), member(1, 'child.jpg', false), member(2, 'raw.dng', true)]);
    expect(idsOf(selectGalleryAssetTargets(coverExported, 'nonRaw'))).toEqual([ids[1]]);
    const childExported = card([member(0, 'cover.jpg', false), member(1, 'child.jpg', false, true), member(2, 'raw.dng', true)]);
    expect(idsOf(selectGalleryAssetTargets(childExported, 'nonRaw'))).toEqual([ids[0]]);
    const allExported = card([member(0, 'cover.jpg', false, true), member(1, 'child.jpg', false, true), member(2, 'raw.dng', true, true)]);
    expect(selectGalleryAssetTargets(allExported, 'both')).toMatchObject({ status: 'ready', assets: [] });
    expect(selectGalleryAssetTargets({ ...coverExported, stackMembers: null }, 'nonRaw')).toMatchObject({ status: 'unavailable', assets: null });
    expect(selectGalleryAssetTargets({ ...coverExported, stackMembers: undefined }, 'nonRaw').status).toBe('unavailable');
    expect(selectGalleryAssetTargets({ ...coverExported, stackMembers: [coverExported.stackMembers![0]] }, 'nonRaw').status).toBe('unavailable');
  });

  it('preserves direct selection for unstacked RAW or exported assets', () => {
    const solo = { ...member(0, 'solo-Genzo01.dng', true, true), stackId: null, primaryAssetId: null, stackAssetCount: null };
    expect(selectGalleryAssetTargets(solo, 'nonRaw')).toMatchObject({ status: 'ready', assets: [solo] });
  });

  it('selects from the Phase 1 STACK-ID index and treats missing index entries as unavailable', () => {
    const representative = card([member(0, 'cover.jpg', false), member(1, 'raw.dng', true), member(2, 'export.png', false, true)]);
    const stacks = galleryStacksById([representative]);
    expect(idsOf(selectGalleryStackTargets(stacks, stackId, 'both'))).toEqual([ids[0], ids[1]].sort());
    expect(selectGalleryStackTargets(stacks, '20000000-0000-4000-8000-000000000001', 'nonRaw').status).toBe('unavailable');
  });

  it('applies manual IDs after eligibility checks, including a valid empty selection', () => {
    const stack = card([member(0, 'cover.jpg', false), member(1, 'output.jpg', false, true), member(2, 'raw.dng', true)]);
    expect(idsOf(selectGalleryAssetTargets(stack, 'both', new Set([ids[1], ids[2]])))).toEqual([ids[2]]);
    expect(selectGalleryAssetTargets(stack, 'both', new Set()).assets).toEqual([]);
  });
});
