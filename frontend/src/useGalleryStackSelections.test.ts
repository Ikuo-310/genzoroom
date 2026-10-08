// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { resolveGalleryStackSelection, restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection,
  acceptGalleryStackSnapshots, beginGalleryStackSnapshotRequest, GALLERY_STACK_SELECTION_SESSION_KEY } from './useGalleryStackSelections';

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
