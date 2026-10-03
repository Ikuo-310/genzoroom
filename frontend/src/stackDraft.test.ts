import { expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { chooseStackCover, detectStackCandidates } from './stackCandidateDetection';
import { buildStackWritePlan } from './stackWrite';
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

it('undoes every local Stack composition action as one step', () => {
  const original = initial();
  const cases: Array<[StackDraftAction[], (draft: ReturnType<typeof initial>) => void]> = [
    [[{ type: 'cover', groupId: first, assetId: 'a' }], draft => expect(draft.groups[0].coverAssetId).toBe('b')],
    [[{ type: 'select', assetId: 'x' }, { type: 'target', groupId: first }, { type: 'add' }], draft => {
      expect(ids(draft.unmatched)).toContain('x'); expect(ids(draft.groups[0].members)).not.toContain('x');
    }],
    [[{ type: 'select', assetId: 'x' }, { type: 'select', assetId: 'y' }, { type: 'create' }], draft => {
      expect(draft.groups.some(group => group.origin === 'manual')).toBe(false); expect(draft.manualCounter).toBe(0);
    }],
    [[{ type: 'purgeMember', groupId: first, assetId: 'a' }], draft => expect(ids(draft.groups[0].members)).toEqual(['a', 'b', 'c'])],
    [[{ type: 'purgeGroup', groupId: first }], draft => expect(draft.groups[0].id).toBe(first)],
    [[{ type: 'moveMember', assetId: 'a', sourceGroupId: first, targetGroupId: second }], draft => {
      expect(ids(draft.groups.find(group => group.id === first)!.members)).toEqual(['a', 'b', 'c']);
    }],
    [[{ type: 'dropUnmatched', assetId: 'x', targetGroupId: first }], draft => expect(ids(draft.unmatched)).toContain('x')],
    [[{ type: 'purgeMember', groupId: second, assetId: 'd' }], draft => expect(ids(draft.groups.find(group => group.id === second)!.members)).toEqual(['d', 'e'])],
  ];
  for (const [edits, verify] of cases) {
    let edited = edits.reduce(reduce, original);
    expect(edited.undoSnapshot).not.toBeNull();
    edited = reduce(edited, { type: 'undo' });
    expect(edited.groups).toEqual(original.groups); expect(edited.unmatched).toEqual(original.unmatched);
    verify(edited); expect(edited.undoSnapshot).toBeNull(); expect(reduce(edited, { type: 'undo' })).toBe(edited);
  }
});

it('keeps only the newest edit snapshot and leaves no-op edits from consuming it', () => {
  let draft = reduce(initial(), { type: 'cover', groupId: first, assetId: 'a' });
  const firstEditGroups = draft.groups;
  draft = reduce(draft, { type: 'cover', groupId: first, assetId: 'a' });
  expect(draft.groups).toBe(firstEditGroups);
  const invalidAdd = reduce(draft, { type: 'add', targetGroupId: 'missing' });
  expect(invalidAdd).toBe(draft);
  draft = reduce(draft, { type: 'dropUnmatched', assetId: 'missing', targetGroupId: first });
  expect(draft.undoSnapshot).not.toBeNull();
  draft = reduce(draft, { type: 'cover', groupId: first, assetId: 'c' });
  draft = reduce(draft, { type: 'undo' });
  expect(draft.groups[0].coverAssetId).toBe('a');
  expect(draft.modified).toBe(true);
});

it('clears Undo on source initialization, reset, and write result application', () => {
  const edited = reduce(initial(), { type: 'cover', groupId: first, assetId: 'a' });
  expect(reduce(edited, { type: 'initialize', source, assets }).undoSnapshot).toBeNull();
  expect(reduce(edited, { type: 'reset' }).undoSnapshot).toBeNull();
  expect(reduce(edited, { type: 'writeResults', plan: { operations: [], unchanged: [] }, results: [] }).undoSnapshot).toBeNull();
});

it('reconciles Immich lineage after Undo and does not collide manual IDs', () => {
  const immichGroup = { ...source.groups[0], origin: 'immich' as const, immichStackId: 'stack-id',
    originalMemberIds: source.groups[0].members.map(asset => asset.id), originalPrimaryAssetId: source.groups[0].coverAssetId };
  const immichSource = { ...source, groups: [immichGroup] };
  const immich = reduce(emptyStackDraft, { type: 'initialize', source: immichSource, assets });
  const undone = reduce(reduce(immich, { type: 'cover', groupId: immichGroup.id, assetId: 'a' }), { type: 'undo' });
  expect(undone.groups[0]).toMatchObject({ origin: 'immich', immichStackId: 'stack-id', modified: false });
  expect(undone.groups[0].coverAssetId).toBe(immichGroup.coverAssetId);
  let manual = reduce(undone, { type: 'select', assetId: 'x' });
  manual = reduce(manual, { type: 'select', assetId: 'y' });
  manual = reduce(manual, { type: 'create' });
  const undoneManual = reduce(manual, { type: 'undo' });
  expect(undoneManual.groups.map(group => group.id)).toEqual([immichGroup.id]);
  let after = reduce(undone, { type: 'select', assetId: 'x' });
  after = reduce(after, { type: 'select', assetId: 'y' });
  after = reduce(after, { type: 'create' });
  expect(after.groups.at(-1)?.id).toBe('draft:manual:1');
  expect(new Set(after.groups.map(group => group.id)).size).toBe(after.groups.length);
});

it('creates a manual Stack atomically from two unmatched photos, preserves order, Cover rules and create classification', () => {
  const original = initial();
  const extra = { ...assets[0], id: 'z', filename: 'last.jpg' };
  const before = { ...original, unmatched: original.unmatched.map(asset => asset.id === 'x' ? { ...asset, date: '2026-10-02' }
    : asset.id === 'y' ? { ...asset, date: '2026-10-03' } : asset).concat(extra),
    order: new Map([...original.order, [extra.id, assets.length]]) };
  const created = reduce(before, { type: 'createFromUnmatchedDrop', draggedAssetId: 'x', targetAssetId: 'y' });
  const group = created.groups.at(-1)!;
  expect(group).toMatchObject({ id: 'draft:manual:1', origin: 'manual', coverAssetId: 'y' });
  expect(group.coverAssetId).toBe(chooseStackCover(group.members));
  expect(ids(group.members)).toEqual(['x', 'y']); expect(ids(created.unmatched)).toEqual(['z']);
  expect(created.manualCounter).toBe(1);
  expect(buildStackWritePlan(created.groups, created.sourceGroups ?? []).operations.find(op => op.operationId === group.id)?.type).toBe('create');
  const undone = reduce(created, { type: 'undo' });
  expect(undone.groups).toEqual(before.groups); expect(ids(undone.unmatched)).toEqual(['x', 'y', 'z']);
  expect(undone.manualCounter).toBe(0);
  const recreated = reduce(undone, { type: 'createFromUnmatchedDrop', draggedAssetId: 'y', targetAssetId: 'x' });
  expect(recreated.groups.at(-1)?.id).toBe(group.id);
  expect(new Set(recreated.groups.map(item => item.id)).size).toBe(recreated.groups.length);
});

it('ignores invalid unmatched photo drops without replacing the current Undo snapshot', () => {
  const base = initial();
  const edited = reduce(base, { type: 'cover', groupId: first, assetId: 'a' });
  const invalid = [
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: 'x', targetAssetId: 'x' },
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: 'absent', targetAssetId: 'x' },
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: 'x', targetAssetId: 'absent' },
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: 'a', targetAssetId: 'x' },
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: 'x', targetAssetId: 'b' },
    { ...edited, type: 'createFromUnmatchedDrop' as const, draggedAssetId: '', targetAssetId: 'x' },
  ];
  for (const action of invalid) {
    const { type: _type, draggedAssetId, targetAssetId } = action;
    expect(reduce(edited, { type: 'createFromUnmatchedDrop', draggedAssetId, targetAssetId })).toBe(edited);
  }
  const duplicate = { ...edited, unmatched: [...edited.unmatched, edited.unmatched[0]] };
  expect(reduce(duplicate, { type: 'createFromUnmatchedDrop', draggedAssetId: 'x', targetAssetId: 'y' })).toBe(duplicate);
});
