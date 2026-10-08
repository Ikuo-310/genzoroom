import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTO_FILTERS,
  EDIT_STATUS_FILTER_SESSION_KEYS,
  EDIT_STATUS_FILTER_SESSION_KEY,
  filterPhotos,
  filterPhotosByEditStatus,
  filterPhotosByDevelopStatus,
  isGenzoRoomExported,
  DEVELOP_STATUS_FILTER_SESSION_KEYS,
  readDevelopStatusFilterMode,
  writeDevelopStatusFilterMode,
  PHOTO_FILTER_SESSION_KEY,
  PHOTO_FILTER_SESSION_KEYS,
  photoFiltersForMode,
  readPhotoFilterMode,
  readEditStatusFilterMode,
  writeEditStatusFilterMode,
  writePhotoFilterMode,
} from './photoFilters';

const photos = [
  { id: 'raw-1', is_raw: true },
  { id: 'non-raw-1', is_raw: false },
  { id: 'raw-2', is_raw: true },
];

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as unknown as Storage,
  };
}

describe('photo filters', () => {
  it('keeps Favorite filters separate and restores them after reads', () => {
    const { storage, values } = makeStorage();
    writePhotoFilterMode('raw', 'recent', storage);
    writePhotoFilterMode('nonRaw', 'favorites', storage);
    writeEditStatusFilterMode('edited', 'favorites', storage);
    expect(PHOTO_FILTER_SESSION_KEYS.favorites).toBe('genzoroom.homePhotoFilter.favorites');
    expect(EDIT_STATUS_FILTER_SESSION_KEYS.favorites).toBe('genzoroom.homeEditStatusFilter.favorites');
    expect(values.get(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(readPhotoFilterMode('favorites', storage)).toBe('nonRaw');
    expect(readEditStatusFilterMode('favorites', storage)).toBe('edited');
    expect(readEditStatusFilterMode('recent', storage)).toBe('both');
  });
  it('starts with RAW and Non-RAW enabled', () => {
    expect(DEFAULT_PHOTO_FILTERS).toEqual({ raw: true, nonRaw: true });
  });

  it('filters photos for the selected format', () => {
    expect(filterPhotos(photos, DEFAULT_PHOTO_FILTERS)).toEqual(photos);
    expect(filterPhotos(photos, photoFiltersForMode('raw'))).toEqual([photos[0], photos[2]]);
    expect(filterPhotos(photos, photoFiltersForMode('nonRaw'))).toEqual([photos[1]]);
    expect(filterPhotos(photos.filter(photo => photo.is_raw), photoFiltersForMode('nonRaw'))).toEqual([]);
  });

  it('stores and restores independent values for each Home tab', () => {
    const { storage, values } = makeStorage();
    expect(readPhotoFilterMode('recent', storage)).toBe('both');
    expect(readPhotoFilterMode('albums', storage)).toBe('both');
    expect(readPhotoFilterMode('calendar', storage)).toBe('both');
    writePhotoFilterMode('raw', 'recent', storage);
    writePhotoFilterMode('nonRaw', 'calendar', storage);
    expect(values.get(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(values.get(PHOTO_FILTER_SESSION_KEYS.albums)).toBeUndefined();
    expect(values.get(PHOTO_FILTER_SESSION_KEYS.calendar)).toBe('nonRaw');
    expect(readPhotoFilterMode('recent', storage)).toBe('raw');
    expect(readPhotoFilterMode('albums', storage)).toBe('both');
    expect(readPhotoFilterMode('calendar', storage)).toBe('nonRaw');
  });

  it('migrates the legacy shared value to Recent only', () => {
    const { storage, values } = makeStorage({ [PHOTO_FILTER_SESSION_KEY]: 'raw' });
    expect(readPhotoFilterMode('recent', storage)).toBe('raw');
    expect(values.get(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(readPhotoFilterMode('albums', storage)).toBe('both');
    expect(readPhotoFilterMode('calendar', storage)).toBe('both');
  });

  it('prefers an existing Recent value over the legacy key', () => {
    const { storage } = makeStorage({
      [PHOTO_FILTER_SESSION_KEY]: 'raw',
      [PHOTO_FILTER_SESSION_KEYS.recent]: 'nonRaw',
    });
    expect(readPhotoFilterMode('recent', storage)).toBe('nonRaw');
  });

  it('falls back only the affected tab to both for invalid values', () => {
    const { storage } = makeStorage({
      [PHOTO_FILTER_SESSION_KEYS.recent]: 'broken',
      [PHOTO_FILTER_SESSION_KEYS.albums]: 'raw',
      [PHOTO_FILTER_SESSION_KEYS.calendar]: 'nonRaw',
      [PHOTO_FILTER_SESSION_KEY]: 'invalid-legacy',
    });
    expect(readPhotoFilterMode('recent', storage)).toBe('both');
    expect(readPhotoFilterMode('albums', storage)).toBe('raw');
    expect(readPhotoFilterMode('calendar', storage)).toBe('nonRaw');
  });

  it('keeps tab-specific memory fallbacks when session storage throws', () => {
    const unavailable = {
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Blocked'); },
    } as unknown as Storage;
    writePhotoFilterMode('both', 'recent', unavailable);
    writePhotoFilterMode('both', 'albums', unavailable);
    writePhotoFilterMode('both', 'calendar', unavailable);
    writePhotoFilterMode('raw', 'recent', unavailable);
    writePhotoFilterMode('nonRaw', 'calendar', unavailable);
    expect(readPhotoFilterMode('recent', unavailable)).toBe('raw');
    expect(readPhotoFilterMode('albums', unavailable)).toBe('both');
    expect(readPhotoFilterMode('calendar', unavailable)).toBe('nonRaw');
  });
});

describe('edit status filters', () => {
  const assets = [{ id: 'edited', is_raw: true }, { id: 'unedited', is_raw: false }];

  it('keeps independent values per tab and restores them from session storage', () => {
    const { storage, values } = makeStorage();
    expect(readEditStatusFilterMode('recent', storage)).toBe('both');
    expect(readEditStatusFilterMode('albums', storage)).toBe('both');
    expect(readEditStatusFilterMode('calendar', storage)).toBe('both');
    writeEditStatusFilterMode('edited', 'recent', storage);
    writeEditStatusFilterMode('unedited', 'calendar', storage);
    expect(values.get(EDIT_STATUS_FILTER_SESSION_KEYS.recent)).toBe('edited');
    expect(values.get(EDIT_STATUS_FILTER_SESSION_KEYS.albums)).toBeUndefined();
    expect(values.get(EDIT_STATUS_FILTER_SESSION_KEYS.calendar)).toBe('unedited');
    expect(EDIT_STATUS_FILTER_SESSION_KEY).toBe('genzoroom.homeEditStatusFilter');
    expect(readEditStatusFilterMode('recent', storage)).toBe('edited');
    expect(readEditStatusFilterMode('albums', storage)).toBe('both');
    expect(readEditStatusFilterMode('calendar', storage)).toBe('unedited');
  });

  it('falls back only the affected tab for invalid values', () => {
    const { storage } = makeStorage({
      [EDIT_STATUS_FILTER_SESSION_KEYS.recent]: 'broken',
      [EDIT_STATUS_FILTER_SESSION_KEYS.albums]: 'edited',
      [EDIT_STATUS_FILTER_SESSION_KEYS.calendar]: 'unedited',
    });
    expect(readEditStatusFilterMode('recent', storage)).toBe('both');
    expect(readEditStatusFilterMode('albums', storage)).toBe('edited');
    expect(readEditStatusFilterMode('calendar', storage)).toBe('unedited');
  });

  it('keeps memory fallbacks independent when session storage is unavailable', () => {
    const unavailable = {
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Blocked'); },
    } as unknown as Storage;
    writeEditStatusFilterMode('edited', 'recent', unavailable);
    writeEditStatusFilterMode('both', 'albums', unavailable);
    writeEditStatusFilterMode('unedited', 'calendar', unavailable);
    expect(readEditStatusFilterMode('recent', unavailable)).toBe('edited');
    expect(readEditStatusFilterMode('albums', unavailable)).toBe('both');
    expect(readEditStatusFilterMode('calendar', unavailable)).toBe('unedited');
  });

  it('filters known statuses and leaves unknown statuses visible', () => {
    expect(filterPhotosByEditStatus(assets, 'both', {})).toEqual(assets);
    expect(filterPhotosByEditStatus(assets, 'edited', { edited: true })).toEqual(assets);
    expect(filterPhotosByEditStatus(assets, 'edited', { edited: true, unedited: false })).toEqual([assets[0]]);
    expect(filterPhotosByEditStatus(assets, 'unedited', { edited: true, unedited: false })).toEqual([assets[1]]);
  });
});

describe('GenzoRoom developed status filters', () => {
  const assets = [
    { id: 'exported', isGenzoRoomExport: true },
    { id: 'not-exported', isGenzoRoomExport: false },
    { id: 'unknown', isGenzoRoomExport: undefined },
  ];

  it('uses the exact export badge predicate and filters true versus everything else', () => {
    expect(assets.map(isGenzoRoomExported)).toEqual([true, false, false]);
    expect(filterPhotosByDevelopStatus(assets, 'both')).toBe(assets);
    expect(filterPhotosByDevelopStatus(assets, 'developed')).toEqual([assets[0]]);
    expect(filterPhotosByDevelopStatus(assets, 'undeveloped')).toEqual([assets[1], assets[2]]);
  });

  it('stores and restores independent values per Home tab, defaulting invalid values to both', () => {
    const { storage, values } = makeStorage({
      [DEVELOP_STATUS_FILTER_SESSION_KEYS.recent]: 'developed',
      [DEVELOP_STATUS_FILTER_SESSION_KEYS.albums]: 'invalid',
    });
    writeDevelopStatusFilterMode('undeveloped', 'favorites', storage);
    expect(readDevelopStatusFilterMode('recent', storage)).toBe('developed');
    expect(readDevelopStatusFilterMode('albums', storage)).toBe('both');
    expect(readDevelopStatusFilterMode('calendar', storage)).toBe('both');
    expect(readDevelopStatusFilterMode('favorites', storage)).toBe('undeveloped');
    expect(values.get(DEVELOP_STATUS_FILTER_SESSION_KEYS.favorites)).toBe('undeveloped');
  });

  it('keeps the per-tab memory value when session storage is blocked', () => {
    const unavailable = {
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Blocked'); },
    } as unknown as Storage;
    writeDevelopStatusFilterMode('developed', 'recent', unavailable);
    writeDevelopStatusFilterMode('undeveloped', 'favorites', unavailable);
    expect(readDevelopStatusFilterMode('recent', unavailable)).toBe('developed');
    expect(readDevelopStatusFilterMode('albums', unavailable)).toBe('both');
    expect(readDevelopStatusFilterMode('favorites', unavailable)).toBe('undeveloped');
  });
});
