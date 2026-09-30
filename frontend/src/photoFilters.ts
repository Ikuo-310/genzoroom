export type PhotoFilters = {
  raw: boolean;
  nonRaw: boolean;
};

export const DEFAULT_PHOTO_FILTERS: PhotoFilters = {
  raw: true,
  nonRaw: true,
};

export function filterPhotos<T extends { is_raw: boolean }>(
  photos: T[],
  filters: PhotoFilters,
): T[] {
  return photos.filter((photo) => photo.is_raw ? filters.raw : filters.nonRaw);
}
