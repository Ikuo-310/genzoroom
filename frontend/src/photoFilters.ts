import type { AssetEditStatuses } from './editStatus';

export type PhotoFilters = {
  raw: boolean;
  nonRaw: boolean;
};
export type StackFilterMode = 'both' | 'stacked' | 'unstacked';
export type StackFilterTab = 'recent' | 'albums' | 'calendar';
export type PhotoFilterMode = 'both' | 'raw' | 'nonRaw';
export type EditStatusFilterMode = 'both' | 'edited' | 'unedited';
export type DevelopStatusFilterMode = 'both' | 'developed' | 'undeveloped';
export type PhotoFilterTab = 'recent' | 'albums' | 'calendar' | 'favorites';

// Keep the former shared key readable for sessions created before filters were tab-scoped.
export const PHOTO_FILTER_SESSION_KEY = 'genzoroom.homePhotoFilter';
export const PHOTO_FILTER_SESSION_KEYS: Record<PhotoFilterTab, string> = {
  recent: `${PHOTO_FILTER_SESSION_KEY}.recent`,
  albums: `${PHOTO_FILTER_SESSION_KEY}.albums`,
  calendar: `${PHOTO_FILTER_SESSION_KEY}.calendar`,
  favorites: `${PHOTO_FILTER_SESSION_KEY}.favorites`,
};
export const EDIT_STATUS_FILTER_SESSION_KEY = 'genzoroom.homeEditStatusFilter';
export const EDIT_STATUS_FILTER_SESSION_KEYS: Record<PhotoFilterTab, string> = {
  recent: `${EDIT_STATUS_FILTER_SESSION_KEY}.recent`,
  albums: `${EDIT_STATUS_FILTER_SESSION_KEY}.albums`,
  calendar: `${EDIT_STATUS_FILTER_SESSION_KEY}.calendar`,
  favorites: `${EDIT_STATUS_FILTER_SESSION_KEY}.favorites`,
};
export const DEVELOP_STATUS_FILTER_SESSION_KEYS: Record<PhotoFilterTab, string> = {
  recent: 'genzoroom.homeDevelopStatusFilter.recent',
  albums: 'genzoroom.homeDevelopStatusFilter.albums',
  calendar: 'genzoroom.homeDevelopStatusFilter.calendar',
  favorites: 'genzoroom.homeDevelopStatusFilter.favorites',
};

export const DEFAULT_PHOTO_FILTERS: PhotoFilters = {
  raw: true,
  nonRaw: true,
};

const memoryPhotoFilterModes: Record<PhotoFilterTab, PhotoFilterMode> = {
  recent: 'both',
  albums: 'both',
  calendar: 'both',
  favorites: 'both',
};
const memoryEditStatusFilterModes: Record<PhotoFilterTab, EditStatusFilterMode> = {
  recent: 'both',
  albums: 'both',
  calendar: 'both',
  favorites: 'both',
};
const memoryDevelopStatusFilterModes: Record<PhotoFilterTab, DevelopStatusFilterMode> = {
  recent: 'both',
  albums: 'both',
  calendar: 'both',
  favorites: 'both',
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

export function readDevelopStatusFilterMode(
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): DevelopStatusFilterMode {
  if (storage === null) return memoryDevelopStatusFilterModes[tab];
  try {
    const stored = storage.getItem(DEVELOP_STATUS_FILTER_SESSION_KEYS[tab]);
    const mode = stored === 'both' || stored === 'developed' || stored === 'undeveloped' ? stored : 'both';
    memoryDevelopStatusFilterModes[tab] = mode;
    return mode;
  } catch {
    // A blocked session store must not couple the in-memory choices between tabs.
  }
  return memoryDevelopStatusFilterModes[tab];
}

export function writeDevelopStatusFilterMode(
  mode: DevelopStatusFilterMode,
  tab: PhotoFilterTab = 'recent',
  storage = browserSessionStorage(),
): void {
  memoryDevelopStatusFilterModes[tab] = mode;
  try { storage?.setItem(DEVELOP_STATUS_FILTER_SESSION_KEYS[tab], mode); }
  catch { /* Keep each tab's choice in memory when session storage is blocked. */ }
}

export function isGenzoRoomExported(asset: { isGenzoRoomExport?: boolean }): boolean {
  return asset.isGenzoRoomExport === true;
}

export function filterPhotosByDevelopStatus<T extends { isGenzoRoomExport?: boolean }>(
  photos: T[],
  mode: DevelopStatusFilterMode,
): T[] {
  if (mode === 'both') return photos;
  return photos.filter(asset => isGenzoRoomExported(asset) === (mode === 'developed'));
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

export const STACK_FILTER_SESSION_KEYS: Record<StackFilterTab, string> = {
  recent: 'genzoroom.homeStackFilter.recent',
  albums: 'genzoroom.homeStackFilter.albums',
  calendar: 'genzoroom.homeStackFilter.calendar',
};
const memoryStackFilterModes: Record<StackFilterTab, StackFilterMode> = {
  recent: 'both', albums: 'both', calendar: 'both',
};

export function readStackFilterMode(
  tab: StackFilterTab = 'recent', storage = browserSessionStorage(),
): StackFilterMode {
  if (storage === null) return memoryStackFilterModes[tab];
  try {
    const stored = storage.getItem(STACK_FILTER_SESSION_KEYS[tab]);
    memoryStackFilterModes[tab] = stored === 'stacked' || stored === 'unstacked' ? stored : 'both';
  } catch {
    // Keep each tab's in-memory choice when browser storage is blocked.
  }
  return memoryStackFilterModes[tab];
}

export function writeStackFilterMode(
  mode: StackFilterMode, tab: StackFilterTab = 'recent', storage = browserSessionStorage(),
): void {
  memoryStackFilterModes[tab] = mode;
  try { storage?.setItem(STACK_FILTER_SESSION_KEYS[tab], mode); }
  catch { /* Preserve the tab's choice in memory when browser storage is blocked. */ }
}
