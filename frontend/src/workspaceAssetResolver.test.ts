import { describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { resolveWorkspaceAsset, resolveWorkspaceAssets } from './workspaceAssetResolver';

function asset(id: string, is_raw = false, stackId?: string, primaryAssetId?: string): RecentAsset {
  return { id, filename: id, date: '2026-09-01', thumbnail_url: `/thumb/${id}`,
    format: is_raw ? 'DNG' : 'JPEG', is_raw, stackId, primaryAssetId };
}
const jpeg = asset('jpeg', false, 's', 'jpeg');
const raw = asset('raw', true, 's', 'jpeg');

describe('workspace Asset resolution', () => {
  it.each([false, true])('preserves unstacked assets, including RAW=%s', isRaw => {
    const photo = asset('plain', isRaw);
    expect(resolveWorkspaceAsset(photo, [jpeg, raw])).toEqual({ status: 'resolved', asset: photo });
  });
  it.each([jpeg, raw])('resolves either member of JPEG primary + RAW to JPEG ($id)', clicked => {
    expect(resolveWorkspaceAsset(clicked, [raw, jpeg])).toEqual({ status: 'resolved', asset: jpeg });
  });
  it('chooses the sole non-RAW member when primary is RAW', () => {
    const members = [asset('raw', true, 's', 'raw'), asset('jpeg', false, 's', 'raw')];
    expect(resolveWorkspaceAsset(members[0], members)).toEqual({ status: 'resolved', asset: members[1] });
  });
  it('chooses the non-RAW primary among multiple candidates', () => {
    const png = asset('png', false, 's', 'jpeg');
    expect(resolveWorkspaceAsset(png, [png, raw, jpeg])).toEqual({ status: 'resolved', asset: jpeg });
  });
  it('rejects RAW-only or incompletely loaded Stacks', () => {
    expect(resolveWorkspaceAsset(raw, [raw, asset('raw2', true, 's')])).toEqual({ status: 'unsupported' });
    expect(resolveWorkspaceAsset(raw, [raw, asset('jpeg', false, 'other', 'jpeg')])).toEqual({ status: 'unsupported' });
  });
  it.each(['raw', undefined, 'missing', 'other-primary'])('does not guess among multiple candidates with primary %s', primary => {
    const clicked = asset('raw', true, 's', primary);
    const members = [clicked, asset('a', false, 's'), asset('b', false, 's'), asset('other-primary', false, 'other')];
    expect(resolveWorkspaceAsset(clicked, members)).toEqual({ status: 'ambiguous' });
  });
  it('uses same-Stack membership even when primary metadata is missing', () => {
    const clicked = asset('raw', true, 's');
    expect(resolveWorkspaceAsset(clicked, [clicked, jpeg, asset('other', false, 'other')]))
      .toEqual({ status: 'resolved', asset: jpeg });
  });
  it('preserves selection order and deduplicates at the first resolved position without mutating inputs', () => {
    const a = asset('a'), c = asset('c');
    const selected = [a, raw, c, jpeg];
    const current = [c, jpeg, raw, a];
    expect(resolveWorkspaceAssets(selected, current)).toEqual({ status: 'resolved', assets: [a, jpeg, c] });
    expect(selected).toEqual([a, raw, c, jpeg]);
    expect(current).toEqual([c, jpeg, raw, a]);
  });
  it.each(['unsupported', 'ambiguous'] as const)('returns no partial assets for %s selections', status => {
    const a = asset('a');
    const members = status === 'unsupported' ? [a, raw] : [a, raw, asset('b', false, 's'), asset('c', false, 's')];
    expect(resolveWorkspaceAssets([a, raw], members)).toEqual({ status });
  });
});
