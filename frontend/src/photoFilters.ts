export type PhotoFilters = {
  raw: boolean;
  nonRaw: boolean;
};
export type PhotoFilterMode = 'both' | 'raw' | 'nonRaw';

export const PHOTO_FILTER_SESSION_KEY = 'genzoroom.homePhotoFilter';

export const DEFAULT_PHOTO_FILTERS: PhotoFilters = {
  raw: true,
  nonRaw: true,
};

let memoryPhotoFilterMode: PhotoFilterMode = 'both';

function browserSessionStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

export function readPhotoFilterMode(storage = browserSessionStorage()): PhotoFilterMode {
  if (storage === null) return memoryPhotoFilterMode;
  try {
    const value = storage.getItem(PHOTO_FILTER_SESSION_KEY);
    if (value === 'both' || value === 'raw' || value === 'nonRaw') {
      memoryPhotoFilterMode = value;
      return value;
    }
    memoryPhotoFilterMode = 'both';
  } catch {
    // The in-memory choice keeps the filter usable when browser storage is blocked.
  }
  return memoryPhotoFilterMode;
}

export function writePhotoFilterMode(mode: PhotoFilterMode, storage = browserSessionStorage()): void {
  memoryPhotoFilterMode = mode;
  try { storage?.setItem(PHOTO_FILTER_SESSION_KEY, mode); }
  catch { /* Keep the active tab's choice in memory when session storage is blocked. */ }
}

export function photoFiltersForMode(mode: PhotoFilterMode): PhotoFilters {
  return mode === 'both' ? { raw: true, nonRaw: true }
    : mode === 'raw' ? { raw: true, nonRaw: false }
      : { raw: false, nonRaw: true };
}

export function filterPhotos<T extends { is_raw: boolean }>(
  photos: T[],
  filters: PhotoFilters,
): T[] {
  return photos.filter((photo) => photo.is_raw ? filters.raw : filters.nonRaw);
}
