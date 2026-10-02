import { describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { collapseImmichStacks } from './immichStacks';

function asset(id: string, stackId?: string | null, primaryAssetId?: string | null): RecentAsset {
  return { id, stackId, primaryAssetId, filename: `${id}.jpg`, date: '2026-09-01',
    thumbnail_url: `/thumb/${id}`, format: 'JPEG', is_raw: false };
}
const x = asset('x');
const y = asset('y');
const primary = asset('a', 's', 'a');
const member = asset('b', 's', 'a');
const otherMember = asset('c', 's', 'a');

// Representative identity matters: callers must retain fetched metadata and selection IDs.
describe('Immich stack display collapse', () => {
  it('preserves unstacked assets, their order and object identity', () => {
    const input = [x, asset('null', null, null), y];
    const result = collapseImmichStacks(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result[0]).toBe(x);
    expect(collapseImmichStacks([])).toEqual([]);
  });

  it('keeps the primary from a two-member stack', () => {
    expect(collapseImmichStacks([primary, member])).toEqual([primary]);
  });

  it('keeps the primary from a three-member stack', () => {
    expect(collapseImmichStacks([member, primary, otherMember])).toEqual([primary]);
  });

  it('chooses each stack primary independently', () => {
    const secondPrimary = asset('d', 't', 'd');
    const secondMember = asset('e', 't', 'd');
    expect(collapseImmichStacks([member, secondMember, secondPrimary, primary]))
      .toEqual([primary, secondPrimary]);
  });

  it.each([[x, member, primary, y], [x, member, y, primary]])(
    'places a later primary at the first member slot (%#)', (...input) => {
      expect(collapseImmichStacks(input)).toEqual([x, primary, y]);
    },
  );

  it('retains the first member when the primary is absent', () => {
    expect(collapseImmichStacks([x, member, otherMember, y])).toEqual([x, member, y]);
    expect(collapseImmichStacks([otherMember])).toEqual([otherMember]);
  });

  it.each([undefined, null, ''])('retains assets with incomplete metadata (%#)', missing => {
    const noPrimary = asset('b', 's', missing);
    const noStack = asset('c', missing, 'a');
    const input = [x, noPrimary, noStack, primary, y];
    expect(collapseImmichStacks(input)).toEqual(input);
  });

  it('retains all members when primary IDs conflict', () => {
    const inconsistent = asset('c', 's', 'c');
    const input = [member, primary, inconsistent];
    expect(collapseImmichStacks(input)).toEqual(input);
  });

  it('does not borrow a primary from an unrelated stack or unstacked asset', () => {
    const unrelated = asset('a');
    expect(collapseImmichStacks([member, unrelated, otherMember])).toEqual([member, unrelated]);
  });

  it('does not mutate the fetched array or assets', () => {
    const input = Object.freeze([x, member, primary, y].map(a => Object.freeze({ ...a })));
    expect(collapseImmichStacks(input)).toEqual([x, primary, y]);
    expect(input.map(a => a.id)).toEqual(['x', 'b', 'a', 'y']);
    expect(collapseImmichStacks(input)[1]).toBe(input[2]);
  });
});
