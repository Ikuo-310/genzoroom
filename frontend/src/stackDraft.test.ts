import { expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { detectStackCandidates } from './stackCandidateDetection';
import { emptyStackDraft, stackDraftReducer as reduce, type StackDraftAction } from './useEditableStackDraft';

const assets: RecentAsset[] = [
  ['a', 'one.dng', true], ['x', 'single.jpg', false], ['b', 'one.jpg', false],
  ['c', 'one.png', false], ['y', 'other.jpg', false], ['d', 'two.dng', true], ['e', 'two.jpg', false],
].map(([id, filename, raw]) => ({ id: id as string, filename: filename as string, is_raw: raw as boolean,
  format: raw ? 'DNG' : 'JPEG', date: '2026-10-01', thumbnail_url: '/thumb' }));
const source = detectStackCandidates(assets);
const initial = () => reduce(emptyStackDraft, { type: 'initialize', source, assets });
const actions = (...list: StackDraftAction[]) => list.reduce(reduce, initial());
const ids = (list: readonly RecentAsset[]) => list.map(asset => asset.id);
const first = source.groups[0].id, second = source.groups[1].id;

it('copies the source without mutating its groups, members or evidence', () => {
  const draft = initial();
  expect(draft.modified).toBe(false); expect(draft.groups).toEqual(source.groups);
  expect(draft.groups[0]).not.toBe(source.groups[0]); expect(draft.groups[0].members).not.toBe(source.groups[0].members);
  expect(draft.groups[0].evidence).not.toBe(source.groups[0].evidence);
  const changed = reduce(draft, { type: 'purgeMember', groupId: first, assetId: 'b' });
  expect(ids(source.groups[0].members)).toEqual(['a','b','c']); expect(changed.modified).toBe(true);
});
it('purges members in Home order and reselects Cover only when removed', () => {
  const nonCover = actions({ type: 'purgeMember', groupId: first, assetId: 'a' });
  expect(nonCover.groups[0].coverAssetId).toBe('b'); expect(ids(nonCover.unmatched)).toEqual(['a','x','y']);
  expect(nonCover.groups[0].modified).toBe(true);
  const cover = actions({ type: 'purgeMember', groupId: first, assetId: 'b' });
  expect(cover.groups[0].coverAssetId).toBe('c'); expect(ids(cover.unmatched)).toEqual(['x','b','y']);
});
it('dissolves a one-member remainder and clears its Add target', () => {
  const draft = actions({ type:'target',groupId:second },{ type:'purgeMember',groupId:second,assetId:'d' });
  expect(draft.groups).toHaveLength(1); expect(ids(draft.unmatched)).toEqual(['x','y','d','e']);
  expect(draft.addTargetStackId).toBeNull(); expect(draft.selectedIds.size).toBe(0);
});
it('purges a whole group without clearing unrelated unmatched selection', () => {
  const draft = actions({type:'select',assetId:'y'},{type:'target',groupId:first},{type:'purgeGroup',groupId:first});
  expect(draft.groups.map(group=>group.id)).toEqual([second]); expect(ids(draft.unmatched)).toEqual(['a','x','b','c','y']);
  expect([...draft.selectedIds]).toEqual(['y']); expect(draft.addTargetStackId).toBeNull();
});
it('switches or toggles exactly one target without modifying members', () => {
  const draft = actions({type:'target',groupId:first},{type:'target',groupId:second});
  expect(draft.addTargetStackId).toBe(second); expect(draft.modified).toBe(false);
  expect(reduce(draft,{type:'target',groupId:second}).addTargetStackId).toBeNull();
});
it('adds only selected unmatched assets in display order, retaining Cover and uniqueness', () => {
  const draft = actions({type:'select',assetId:'y'},{type:'select',assetId:'a'},{type:'select',assetId:'x'},
    {type:'target',groupId:first},{type:'add'},{type:'add'});
  expect(ids(draft.groups[0].members)).toEqual(['a','b','c','x','y']); expect(draft.unmatched).toHaveLength(0);
  expect(draft.groups[0].coverAssetId).toBe('b'); expect(draft.groups[0].modified).toBe(true);
  expect(draft.addTargetStackId).toBeNull(); expect(draft.selectedIds.size).toBe(0); expect(draft.modified).toBe(true);
});
it('ignores Add without source or target and refuses candidate selection', () => {
  expect(actions({type:'select',assetId:'a'}).selectedIds.size).toBe(0);
  expect(actions({type:'add'}).modified).toBe(false);
  expect(actions({type:'select',assetId:'x'},{type:'add'}).modified).toBe(false);
  expect(actions({type:'target',groupId:first},{type:'add'}).modified).toBe(false);
});
it('creates manual groups in unmatched order with automatic Cover and unique local IDs', () => {
  const draft = actions({type:'select',assetId:'y'},{type:'select',assetId:'x'},{type:'create'});
  const manual=draft.groups[2]; expect(manual.origin).toBe('manual'); expect(manual.id).toBe('draft:manual:1');
  expect(ids(manual.members)).toEqual(['x','y']); expect(manual.coverAssetId).toBe('x');
  expect(manual.evidence.name).toBe('unavailable'); expect(draft.selectedIds.size).toBe(0); expect(draft.modified).toBe(true);
  const dissolved=reduce(draft,{type:'purgeGroup',groupId:manual.id});
  expect(ids(dissolved.unmatched)).toEqual(['x','y']);
  const again=[{type:'select',assetId:'x'},{type:'select',assetId:'y'},{type:'create'}] as StackDraftAction[];
  expect(again.reduce(reduce,dissolved).groups[2].id).toBe('draft:manual:2');
});
it('requires two unmatched photos for a new Stack', () => expect(actions({type:'select',assetId:'x'},{type:'create'}).modified).toBe(false));
it('Cover edits preserve membership evidence and never select a photo', () => {
  const draft=actions({type:'cover',groupId:first,assetId:'a'});
  expect(draft.groups[0].coverAssetId).toBe('a'); expect(draft.groups[0].modified).toBeUndefined();
  expect(draft.groups[0].evidence).toEqual(source.groups[0].evidence); expect(draft.modified).toBe(true); expect(draft.selectedIds.size).toBe(0);
  expect(reduce(draft,{type:'cover',groupId:first,assetId:'x'})).toBe(draft);
});
it('clears selection and target together and resets all edits on initialization', () => {
  const draft=actions({type:'cover',groupId:first,assetId:'a'},{type:'select',assetId:'x'},{type:'target',groupId:first});
  const cleared=reduce(draft,{type:'clear'}); expect(cleared.selectedIds.size).toBe(0); expect(cleared.addTargetStackId).toBeNull();
  const reset=reduce(draft,{type:'initialize',source,assets}); expect(reset.modified).toBe(false);
  expect(reset.groups).toEqual(source.groups); expect(reset.selectedIds.size).toBe(0); expect(reset.addTargetStackId).toBeNull();
});
