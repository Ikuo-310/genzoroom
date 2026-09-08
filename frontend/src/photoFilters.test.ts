import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTO_FILTERS,
  filterPhotos,
  togglePhotoFilter,
  type PhotoFilters,
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

  it('does not allow the last enabled filter to be turned off', () => {
    const rawOnly: PhotoFilters = { raw: true, nonRaw: false };
    const nonRawOnly: PhotoFilters = { raw: false, nonRaw: true };

    expect(togglePhotoFilter(rawOnly, 'raw')).toBe(rawOnly);
    expect(togglePhotoFilter(nonRawOnly, 'nonRaw')).toBe(nonRawOnly);
  });
});
