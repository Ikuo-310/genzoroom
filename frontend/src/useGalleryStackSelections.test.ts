// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { resolveGalleryStackSelection, restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection,
  GALLERY_STACK_SELECTION_SESSION_KEY } from './useGalleryStackSelections';

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
