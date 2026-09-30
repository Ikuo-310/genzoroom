import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTO_FILTERS,
  filterPhotos,
  PHOTO_FILTER_SESSION_KEY,
  photoFiltersForMode,
  readPhotoFilterMode,
  writePhotoFilterMode,
} from './photoFilters';

const photos = [
  { id: 'raw-1', is_raw: true },
  { id: 'non-raw-1', is_raw: false },
  { id: 'raw-2', is_raw: true },
];

describe('photo filters', () => {
  it('starts with RAW and Non-RAW enabled', () => {
    expect(DEFAULT_PHOTO_FILTERS).toEqual({ raw: true, nonRaw: true });
  });

  it('shows every fetched photo when both filters are enabled', () => {
    expect(filterPhotos(photos, DEFAULT_PHOTO_FILTERS)).toEqual(photos);
  });

  it('shows only RAW photos', () => {
    expect(filterPhotos(photos, { raw: true, nonRaw: false })).toEqual([
      photos[0],
      photos[2],
    ]);
  });

  it('shows only Non-RAW photos', () => {
    expect(filterPhotos(photos, { raw: false, nonRaw: true })).toEqual([
      photos[1],
    ]);
  });

  it('returns an empty result when no fetched photo matches', () => {
    expect(filterPhotos(photos.filter((photo) => photo.is_raw), {
      raw: false,
      nonRaw: true,
    })).toEqual([]);
  });

  it('restores only valid RAW type choices from session storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as unknown as Storage;

    expect(readPhotoFilterMode(storage)).toBe('both');
    writePhotoFilterMode('raw', storage);
    expect(values.get(PHOTO_FILTER_SESSION_KEY)).toBe('raw');
    expect(readPhotoFilterMode(storage)).toBe('raw');
    expect(photoFiltersForMode(readPhotoFilterMode(storage))).toEqual({ raw: true, nonRaw: false });
    writePhotoFilterMode('nonRaw', storage);
    expect(readPhotoFilterMode(storage)).toBe('nonRaw');
    expect(photoFiltersForMode(readPhotoFilterMode(storage))).toEqual({ raw: false, nonRaw: true });
    values.set(PHOTO_FILTER_SESSION_KEY, 'other');
    expect(readPhotoFilterMode(storage)).toBe('both');
  });

  it('keeps the current filter in memory when session storage throws', () => {
    const unavailable = {
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Blocked'); },
    } as unknown as Storage;
    writePhotoFilterMode('both', unavailable);
    writePhotoFilterMode('raw', unavailable);
    expect(readPhotoFilterMode(unavailable)).toBe('raw');
  });
});
