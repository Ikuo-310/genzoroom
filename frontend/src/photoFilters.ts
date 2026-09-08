export type PhotoFilters = {
  raw: boolean;
  nonRaw: boolean;
};

export type PhotoFilterKey = keyof PhotoFilters;

export const DEFAULT_PHOTO_FILTERS: PhotoFilters = {
  raw: true,
  nonRaw: true,
};

export function togglePhotoFilter(
  filters: PhotoFilters,
  filter: PhotoFilterKey,
): PhotoFilters {
  const nextFilters = { ...filters, [filter]: !filters[filter] };
  return nextFilters.raw || nextFilters.nonRaw ? nextFilters : filters;
}

export function filterPhotos<T extends { is_raw: boolean }>(
  photos: T[],
  filters: PhotoFilters,
): T[] {
  return photos.filter((photo) => photo.is_raw ? filters.raw : filters.nonRaw);
}
