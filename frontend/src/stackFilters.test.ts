import { describe, expect, it } from 'vitest';
import type { RecentAsset } from './assets';
import { collapseImmichStacks, filterImmichStacks, filterImmichStacksByEditStatus } from './immichStacks';
import { filterPhotos, photoFiltersForMode, readStackFilterMode, writeStackFilterMode, STACK_FILTER_SESSION_KEYS,
  type PhotoFilterMode, type StackFilterMode, type StackFilterTab } from './photoFilters';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
}
const tabs: StackFilterTab[] = ['recent', 'albums', 'calendar'];

function asset(id: string, raw = false, stacked = false): RecentAsset {
  return { id, is_raw: raw, filename: id, format: raw ? 'DNG' : 'JPEG', date: '2026-09-01', thumbnail_url: '',
    ...(stacked ? { stackId: 's', primaryAssetId: 'b', stackAssetCount: 2 } : {}) };
}
const a = asset('a');
const b = asset('b', false, true);
const c = asset('c', true, true);
const d = asset('d', true);
const assets = [a, b, c, d];

function display(mode: StackFilterMode, type: PhotoFilterMode) {
  const filtered = filterPhotos(filterImmichStacksByEditStatus(filterImmichStacks(assets, mode), 'both', {}), photoFiltersForMode(type));
  return type === 'both' ? collapseImmichStacks(filtered) : filtered;
}

describe('Stack filter storage', () => {
  it('defaults missing or invalid values to both without modifying older filter keys', () => {
    const saved = storage({ [STACK_FILTER_SESSION_KEYS.albums]: 'bad', 'genzoroom.homePhotoFilter': 'raw' });
    expect(readStackFilterMode('recent', saved)).toBe('both');
    expect(readStackFilterMode('albums', saved)).toBe('both');
    expect(saved.getItem('genzoroom.homePhotoFilter')).toBe('raw');
  });
  it.each(['both', 'stacked', 'unstacked'] as const)('round trips %s independently for each tab', mode => {
    const saved = storage();
    for (const tab of tabs) {
      writeStackFilterMode(mode, tab, saved);
      expect(readStackFilterMode(tab, saved)).toBe(mode);
      expect(saved.getItem(STACK_FILTER_SESSION_KEYS[tab])).toBe(mode);
    }
    writeStackFilterMode('stacked', 'recent', saved);
    writeStackFilterMode('unstacked', 'calendar', saved);
    expect(readStackFilterMode('recent', saved)).toBe('stacked');
    expect(readStackFilterMode('calendar', saved)).toBe('unstacked');
    expect(readStackFilterMode('albums', saved)).toBe(mode);
  });
  it('preserves separate memory choices when storage throws or is unavailable', () => {
    const blocked = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } } as unknown as Storage;
    writeStackFilterMode('stacked', 'recent', blocked);
    writeStackFilterMode('both', 'albums', blocked);
    writeStackFilterMode('unstacked', 'calendar', null);
    expect(readStackFilterMode('recent', blocked)).toBe('stacked');
    expect(readStackFilterMode('albums', null)).toBe('both');
    expect(readStackFilterMode('calendar', blocked)).toBe('unstacked');
    for (const tab of tabs) writeStackFilterMode('both', tab, null);
  });
});

describe('Stack / edit / type display', () => {
  it.each([
    ['both', 'both', ['a', 'b', 'd']], ['stacked', 'both', ['b']], ['unstacked', 'both', ['a', 'd']],
    ['stacked', 'raw', ['c']], ['stacked', 'nonRaw', ['b']], ['both', 'raw', ['c', 'd']],
    ['both', 'nonRaw', ['a', 'b']], ['unstacked', 'raw', ['d']],
  ] as const)('filters %s / %s', (mode, type, ids) => {
    expect(display(mode, type).map(asset => asset.id)).toEqual(ids);
  });
  it('expands every matching member, not just one per format', () => {
    const input = [b, asset('jpeg2', false, true), c, asset('raw2', true, true)];
    expect(filterPhotos(input, photoFiltersForMode('raw')).map(a => a.id)).toEqual(['c', 'raw2']);
    expect(filterPhotos(input, photoFiltersForMode('nonRaw')).map(a => a.id)).toEqual(['b', 'jpeg2']);
    expect(collapseImmichStacks(input)).toEqual([b]);
  });
  it.each([{ b: false, c: true }, { b: true, c: false }])('aggregates edit status before format filtering (%#)', statuses => {
    const edited = filterImmichStacksByEditStatus([b, c], 'edited', statuses);
    expect(collapseImmichStacks(edited)).toEqual([b]);
    expect(filterPhotos(edited, photoFiltersForMode('nonRaw'))).toEqual([b]);
    expect(filterPhotos(edited, photoFiltersForMode('raw'))).toEqual([c]);
    expect(filterImmichStacksByEditStatus([b, c], 'unedited', statuses)).toEqual([]);
  });
  it('marks a complete all-false stack unedited and treats outside assets individually', () => {
    const statuses = { a: true, b: false, c: false, d: false };
    expect(filterImmichStacksByEditStatus(assets, 'edited', statuses)).toEqual([a]);
    expect(filterImmichStacksByEditStatus(assets, 'unedited', statuses)).toEqual([b, c, d]);
  });
  it.each([{}, { b: false }, { c: false }])('keeps unknown stacks visible in either edit filter (%#)', statuses => {
    expect(filterImmichStacksByEditStatus([b, c], 'edited', statuses)).toEqual([b, c]);
    expect(filterImmichStacksByEditStatus([b, c], 'unedited', statuses)).toEqual([b, c]);
  });
  it('keeps an incomplete stack unknown unless an observed member is edited', () => {
    expect(filterImmichStacksByEditStatus([c], 'edited', { c: false })).toEqual([c]);
    expect(filterImmichStacksByEditStatus([c], 'unedited', { c: false })).toEqual([c]);
    expect(filterImmichStacksByEditStatus([c], 'unedited', { c: true })).toEqual([]);
  });
  it('uses the first available member as fallback and expands it for its format', () => {
    const input = [a, c, asset('raw2', true, true), d];
    expect(collapseImmichStacks(input)).toEqual([a, c, d]);
    expect(filterPhotos(input, photoFiltersForMode('raw')).map(a => a.id)).toEqual(['c', 'raw2', 'd']);
    expect(filterPhotos(input, photoFiltersForMode('nonRaw'))).toEqual([a]);
  });
});
