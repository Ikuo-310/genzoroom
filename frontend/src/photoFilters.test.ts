import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTO_FILTERS,
  filterPhotos,
  PHOTO_FILTER_SESSION_KEY,
  PHOTO_FILTER_SESSION_KEYS,
  photoFiltersForMode,
  readPhotoFilterMode,
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
