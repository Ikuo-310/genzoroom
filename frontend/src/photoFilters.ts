import type { AssetEditStatuses } from './editStatus';

export type PhotoFilters = {
  raw: boolean;
  nonRaw: boolean;
};
export type PhotoFilterMode = 'both' | 'raw' | 'nonRaw';
export type EditStatusFilterMode = 'both' | 'edited' | 'unedited';
export type PhotoFilterTab = 'recent' | 'albums' | 'calendar';

// Keep the former shared key readable for sessions created before filters were tab-scoped.
export const PHOTO_FILTER_SESSION_KEY = 'genzoroom.homePhotoFilter';
export const PHOTO_FILTER_SESSION_KEYS: Record<PhotoFilterTab, string> = {
  recent: `${PHOTO_FILTER_SESSION_KEY}.recent`,
  albums: `${PHOTO_FILTER_SESSION_KEY}.albums`,
  calendar: `${PHOTO_FILTER_SESSION_KEY}.calendar`,
};
export const EDIT_STATUS_FILTER_SESSION_KEY = 'genzoroom.homeEditStatusFilter';
export const EDIT_STATUS_FILTER_SESSION_KEYS: Record<PhotoFilterTab, string> = {
  recent: `${EDIT_STATUS_FILTER_SESSION_KEY}.recent`,
  albums: `${EDIT_STATUS_FILTER_SESSION_KEY}.albums`,
  calendar: `${EDIT_STATUS_FILTER_SESSION_KEY}.calendar`,
};

export const DEFAULT_PHOTO_FILTERS: PhotoFilters = {
  raw: true,
  nonRaw: true,
};

const memoryPhotoFilterModes: Record<PhotoFilterTab, PhotoFilterMode> = {
  recent: 'both',
  albums: 'both',
  calendar: 'both',
};
const memoryEditStatusFilterModes: Record<PhotoFilterTab, EditStatusFilterMode> = {
  recent: 'both',
  albums: 'both',
  calendar: 'both',
};

function browserSessionStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

export function readPhotoFilterMode(
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): PhotoFilterMode {
  if (storage === null) return memoryPhotoFilterModes[tab];
  try {
    const key = PHOTO_FILTER_SESSION_KEYS[tab];
    const stored = storage.getItem(key);
    if (stored !== null) {
      const mode = parsePhotoFilterMode(stored);
      memoryPhotoFilterModes[tab] = mode;
      return mode;
    }

    if (tab === 'recent') {
      const legacy = storage.getItem(PHOTO_FILTER_SESSION_KEY);
      if (legacy !== null) {
        const mode = parsePhotoFilterMode(legacy);
        memoryPhotoFilterModes.recent = mode;
        storage.setItem(key, mode);
        return mode;
      }
    }
    memoryPhotoFilterModes[tab] = 'both';
  } catch {
    // A blocked session store must not couple the in-memory choices between tabs.
  }
  return memoryPhotoFilterModes[tab];
}

function parsePhotoFilterMode(value: string): PhotoFilterMode {
  return value === 'both' || value === 'raw' || value === 'nonRaw' ? value : 'both';
}

export function writePhotoFilterMode(
  mode: PhotoFilterMode,
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): void {
  memoryPhotoFilterModes[tab] = mode;
  try { storage?.setItem(PHOTO_FILTER_SESSION_KEYS[tab], mode); }
  catch { /* Keep each tab's choice in memory when session storage is blocked. */ }
}

export function readEditStatusFilterMode(
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): EditStatusFilterMode {
  if (storage === null) return memoryEditStatusFilterModes[tab];
  try {
    const stored = storage.getItem(EDIT_STATUS_FILTER_SESSION_KEYS[tab]);
    const mode = parseEditStatusFilterMode(stored);
    memoryEditStatusFilterModes[tab] = mode;
    return mode;
  } catch {
    // A blocked session store must not couple the in-memory choices between tabs.
  }
  return memoryEditStatusFilterModes[tab];
}

function parseEditStatusFilterMode(value: string | null): EditStatusFilterMode {
  return value === 'both' || value === 'edited' || value === 'unedited' ? value : 'both';
}

export function writeEditStatusFilterMode(
  mode: EditStatusFilterMode,
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): void {
  memoryEditStatusFilterModes[tab] = mode;
  try { storage?.setItem(EDIT_STATUS_FILTER_SESSION_KEYS[tab], mode); }
  catch { /* Keep each tab's choice in memory when session storage is blocked. */ }
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

export function filterPhotosByEditStatus<T extends { id: string }>(
  photos: T[],
  mode: EditStatusFilterMode,
  statuses: AssetEditStatuses,
): T[] {
  if (mode === 'both') return photos;
  return photos.filter((photo) => {
    const status = statuses[photo.id];
    // Unknown statuses stay visible while batch lookup is pending or has failed.
    return status === undefined || (mode === 'edited' ? status : !status);
  });
}
