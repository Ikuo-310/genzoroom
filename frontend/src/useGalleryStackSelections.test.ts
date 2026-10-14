// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { resolveGalleryStackSelection, restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection,
  acceptGalleryStackSnapshots, beginGalleryStackSnapshotRequest, finishGalleryStackSnapshotRequest, currentGalleryStackOwner, GALLERY_STACK_SELECTION_SESSION_KEY } from './useGalleryStackSelections';

const ids = Array.from({ length: 4 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const stackId = '10000000-0000-4000-8000-000000000001';
function stack(exported: number[] = [], idList = ids.slice(0, 3)): RecentAsset {
  const members = idList.map((id, index): RecentAsset => ({ id, filename: index === 2 ? 'raw.dng' : `${index}.jpg`,
    date: '2026-10-01', thumbnail_url: `/thumb/${index}`, format: index === 2 ? 'DNG' : 'JPEG', is_raw: index === 2,
    isGenzoRoomExport: exported.includes(index), stackId, primaryAssetId: ids[0], stackAssetCount: idList.length }));
  return { ...members[0], stackMemberIds: idList, stackMembers: members };
}

beforeEach(() => { sessionStorage.clear(); restoreGalleryStackSelectionsFromSession(); });
afterEach(() => { sessionStorage.clear(); restoreGalleryStackSelectionsFromSession(); });

describe('Gallery Stack session selections', () => {
  it('resolves old session singles to unique accepted owners without changing the retained assets', () => {
    const cover = stack();
    const single = { ...cover.stackMembers![1], stackId: null, primaryAssetId: null, stackAssetCount: null };
    expect(currentGalleryStackOwner(single)).toBe(single);
    acceptGalleryStackSnapshots([cover], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(cover);
    expect(single.stackId).toBeNull();
    const incomplete = { ...cover, stackMembers: null };
    acceptGalleryStackSnapshots([incomplete], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(single);
  });

  it('does not select an arbitrary owner from conflicting accepted snapshots', () => {
    const cover = stack();
    const otherId = '10000000-0000-4000-8000-000000000002';
    const otherMembers = cover.stackMembers!.map(asset => ({ ...asset, stackId: otherId, primaryAssetId: ids[1] }));
    const other = { ...otherMembers[1], stackMembers: otherMembers, stackMemberIds: ids.slice(0, 3) };
    const single = { ...cover.stackMembers![2], stackId: null, primaryAssetId: null, stackAssetCount: null };
    acceptGalleryStackSnapshots([cover, other], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(single);
  });

  it('does not reuse a cached owner contradicted by a newer member-only Gallery response', () => {
    const cover = stack();
    const single = { ...cover.stackMembers![1], stackId: null, primaryAssetId: null, stackAssetCount: null };
    acceptGalleryStackSnapshots([cover], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(cover);
    acceptGalleryStackSnapshots([single], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(single);
    expect(resolveGalleryStackSelection(cover, 'both').status).toBe('unavailable');
  });

  it('keeps a complete replacement cover when the same response returns a removed member as single', () => {
    const cover = stack();
    const single = { ...cover.stackMembers![2], stackId: null, primaryAssetId: null, stackAssetCount: null };
    acceptGalleryStackSnapshots([cover], beginGalleryStackSnapshotRequest());
    const replacement = stack([], ids.slice(0, 2));
    acceptGalleryStackSnapshots([replacement, single], beginGalleryStackSnapshotRequest());
    expect(currentGalleryStackOwner(single)).toBe(single);
    expect(resolveGalleryStackSelection(cover, 'both').assets?.map(asset => asset.id)).toEqual(ids.slice(0, 2));
  });

  it('ignores a cancelled old single response after a newer Stack owner was accepted', () => {
    const oldRequest = beginGalleryStackSnapshotRequest();
    const cover = stack();
    const single = { ...cover, stackId: null, primaryAssetId: null, stackMemberIds: null, stackMembers: null, stackAssetCount: null };
    acceptGalleryStackSnapshots([cover], beginGalleryStackSnapshotRequest());
    finishGalleryStackSnapshotRequest(oldRequest);
    acceptGalleryStackSnapshots([single], oldRequest);
    expect(currentGalleryStackOwner(single)).toBe(cover);
  });
  it('stores only manual choices and retains an empty manual choice', () => {
    const cover = stack();
    expect(setManualGalleryStackSelection(cover, new Set([ids[1]]))).toBe(true);
    expect(resolveGalleryStackSelection(cover, 'both').assets!.map(asset => asset.id)).toEqual([ids[1]]);
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([ids[1]]);
    expect(setManualGalleryStackSelection(cover, new Set())).toBe(true);
    expect(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)).toContain('"' + stackId + '":[]');
    expect(resolveGalleryStackSelection(cover, 'nonRaw')).toMatchObject({ status: 'ready', assets: [] });
    expect(setManualGalleryStackSelection(cover, new Set(['invalid-id']))).toBe(false);
  });

  it('shares one Stack ID across Gallery tabs, reloads the session, and ignores later presets', () => {
    const cover = stack();
    setManualGalleryStackSelection(cover, new Set([ids[2]]));
    restoreGalleryStackSelectionsFromSession();
    const otherTabCover = { ...cover, filename: 'calendar-cover.jpg' };
    expect(resolveGalleryStackSelection(otherTabCover, 'nonRaw').assets!.map(asset => asset.id)).toEqual([ids[2]]);
  });

  it('reconciles removed and newly exported members while preserving valid manual emptiness', () => {
    const cover = stack();
    setManualGalleryStackSelection(cover, new Set([ids[0], ids[1], ids[2]]));
    const changed = stack([1], [ids[0], ids[1], ids[3]]);
    expect(resolveGalleryStackSelection(changed, 'both').assets!.map(asset => asset.id)).toEqual([ids[0]]);
    expect([...JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]]).toEqual([ids[0]]);
    const exported = stack([0, 1, 2], ids.slice(0, 3));
    expect(resolveGalleryStackSelection(exported, 'both').assets).toEqual([]);
    expect(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)).toContain('"' + stackId + '":[]');
  });

  it('keeps the newest accepted snapshot when requests complete in reverse order', () => {
    const oldRequest = beginGalleryStackSnapshotRequest();
    const newRequest = beginGalleryStackSnapshotRequest();
    const oldSnapshot = stack([], ids.slice(0, 2));
    const newSnapshot = stack([], ids.slice(0, 3));
    acceptGalleryStackSnapshots([newSnapshot], newRequest);
    acceptGalleryStackSnapshots([oldSnapshot], oldRequest);

    expect(resolveGalleryStackSelection(oldSnapshot, 'both').assets?.map(asset => asset.id)).toEqual(ids.slice(0, 3));
  });

  it('does not reconcile from a displayed snapshot while a newer Gallery request is unresolved', () => {
    const oldSnapshot = stack([], ids.slice(0, 2));
    const oldRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([oldSnapshot], oldRequest);
    setManualGalleryStackSelection(oldSnapshot, new Set([ids[1]]));
    const saved = sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY);
    beginGalleryStackSnapshotRequest();

    resolveGalleryStackSelection(oldSnapshot, 'nonRaw');

    expect(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)).toBe(saved);
    expect([...JSON.parse(saved!).selections[stackId]]).toEqual([ids[1]]);
  });

  it('uses the newest complete members for old cards and prunes only confirmed removals or exports', () => {
    const oldSnapshot = stack([], ids.slice(0, 3));
    const oldRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([oldSnapshot], oldRequest);
    setManualGalleryStackSelection(oldSnapshot, new Set([ids[0], ids[1], ids[2]]));
    const currentSnapshot = stack([2], [ids[0], ids[1], ids[3]]);
    const currentRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([currentSnapshot], currentRequest);

    expect(resolveGalleryStackSelection(oldSnapshot, 'both').assets?.map(asset => asset.id)).toEqual([ids[0], ids[1]]);
    expect([...JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]])
      .toEqual([ids[0], ids[1]]);
  });

  it.each(['failed', 'cancelled'])('releases a %s newer request so confirmed removals cannot resurrect', outcome => {
    const original = stack([], ids.slice(0, 2));
    acceptGalleryStackSnapshots([original], beginGalleryStackSnapshotRequest());
    setManualGalleryStackSelection(original, new Set([ids[1]]));
    const removalRequest = beginGalleryStackSnapshotRequest();
    const newerRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([stack([], [ids[0]])], removalRequest);
    resolveGalleryStackSelection(original, 'both');
    expect([...JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]]).toEqual([ids[1]]);

    finishGalleryStackSnapshotRequest(newerRequest);
    if (outcome === 'cancelled') acceptGalleryStackSnapshots([original], newerRequest);
    expect(resolveGalleryStackSelection(original, 'both').assets).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([]);

    acceptGalleryStackSnapshots([original], beginGalleryStackSnapshotRequest());
    expect(resolveGalleryStackSelection(original, 'both').assets).toEqual([]);
  });

  it('does not let a completed unrelated Stack request block reconciliation', () => {
    const original = stack([], ids.slice(0, 2));
    acceptGalleryStackSnapshots([original], beginGalleryStackSnapshotRequest());
    setManualGalleryStackSelection(original, new Set([ids[1]]));
    const removalRequest = beginGalleryStackSnapshotRequest();
    const unrelatedRequest = beginGalleryStackSnapshotRequest();
    const otherStackId = '10000000-0000-4000-8000-000000000002';
    const other = stack([], ids.map(id => id.replace(/^00000000/, '20000000')));
    other.stackId = otherStackId;
    other.primaryAssetId = other.id;
    other.stackMembers = other.stackMembers!.map(member => ({ ...member, stackId: otherStackId, primaryAssetId: other.id }));
    acceptGalleryStackSnapshots([other], unrelatedRequest);
    acceptGalleryStackSnapshots([stack([], [ids[0]])], removalRequest);

    expect(resolveGalleryStackSelection(original, 'both').assets).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([]);
  });

  it('preserves intent on unavailable accepted data and recovers after a failed request', () => {
    const original = stack([], ids.slice(0, 2));
    acceptGalleryStackSnapshots([original], beginGalleryStackSnapshotRequest());
    setManualGalleryStackSelection(original, new Set([ids[1]]));
    acceptGalleryStackSnapshots([{ ...original, stackMembers: null }], beginGalleryStackSnapshotRequest());
    finishGalleryStackSnapshotRequest(beginGalleryStackSnapshotRequest());
    expect(resolveGalleryStackSelection(original, 'both').status).toBe('unavailable');
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([ids[1]]);
    acceptGalleryStackSnapshots([stack([], [ids[0]])], beginGalleryStackSnapshotRequest());
    expect(resolveGalleryStackSelection(original, 'both').assets).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([]);
  });

  it('invalidates an old Stack when the latest response returns its representative as standalone', () => {
    const oldSnapshot = stack([], ids.slice(0, 2));
    const oldRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([oldSnapshot], oldRequest);
    setManualGalleryStackSelection(oldSnapshot, new Set([ids[1]]));
    const saved = sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY);

    const newerRequest = beginGalleryStackSnapshotRequest();
    const standalone = { ...oldSnapshot, stackId: null, primaryAssetId: null,
      stackAssetCount: null, stackMemberIds: null, stackMembers: undefined } as RecentAsset;
    acceptGalleryStackSnapshots([standalone], newerRequest);

    expect(resolveGalleryStackSelection(oldSnapshot, 'both').status).toBe('unavailable');
    expect(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)).toBe(saved);
  });

  it('preserves all-off and never adds new members to a manual selection', () => {
    const oldSnapshot = stack([], ids.slice(0, 2));
    const oldRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([oldSnapshot], oldRequest);
    setManualGalleryStackSelection(oldSnapshot, new Set());
    const newSnapshot = stack([], ids.slice(0, 3));
    const newRequest = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([newSnapshot], newRequest);

    expect(resolveGalleryStackSelection(oldSnapshot, 'both').assets).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)!).selections[stackId]).toEqual([]);
  });

  it('keeps saved intent through unavailable data and restores it when a full snapshot returns', () => {
    const cover = stack();
    setManualGalleryStackSelection(cover, new Set([ids[1]]));
    const stored = sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY);
    const unavailable = { ...cover, stackMembers: null };
    expect(resolveGalleryStackSelection(unavailable, 'both').status).toBe('unavailable');
    expect(sessionStorage.getItem(GALLERY_STACK_SELECTION_SESSION_KEY)).toBe(stored);
    expect(resolveGalleryStackSelection(cover, 'raw').assets!.map(asset => asset.id)).toEqual([ids[1]]);
  });

  it.each(['invalid', '{', '{"version":1,"selections":{"bad":[]}}', '{"version":1,"selections":[]}'])
  ('recovers from malformed saved selection %s', value => {
    sessionStorage.setItem(GALLERY_STACK_SELECTION_SESSION_KEY, value);
    restoreGalleryStackSelectionsFromSession();
    expect(resolveGalleryStackSelection(stack(), 'nonRaw').assets!.map(asset => asset.id)).toEqual([ids[0], ids[1]]);
  });

  it('keeps same-page choices in memory if sessionStorage becomes unavailable', () => {
    const cover = stack();
    setManualGalleryStackSelection(cover, new Set([ids[1]]));
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('Denied'); } });
    try {
      expect(setManualGalleryStackSelection(cover, new Set([ids[2]]))).toBe(true);
      expect(resolveGalleryStackSelection(cover, 'nonRaw').assets!.map(asset => asset.id)).toEqual([ids[2]]);
    } finally {
      if (storageDescriptor) Object.defineProperty(window, 'sessionStorage', storageDescriptor);
    }
  });
});
