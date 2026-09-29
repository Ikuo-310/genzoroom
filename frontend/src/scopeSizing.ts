export const SCOPE_HEIGHT_STORAGE_KEY = 'genzoroom.anshitsu.scope-height';
export const MIN_SCOPE_HEIGHT_PERCENT = 15;
export const MAX_SCOPE_HEIGHT_PERCENT = 40;
export const DEFAULT_SCOPE_HEIGHT_PERCENT = 30;

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readScopePanelBasis(storage: ReadableStorage | undefined = browserStorage()): number {
  try {
    const serialized = storage?.getItem(SCOPE_HEIGHT_STORAGE_KEY);
    if (serialized === null || serialized === undefined) return DEFAULT_SCOPE_HEIGHT_PERCENT;
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SCOPE_HEIGHT_PERCENT) return DEFAULT_SCOPE_HEIGHT_PERCENT;
    return Math.min(MAX_SCOPE_HEIGHT_PERCENT, value);
  } catch {
    return DEFAULT_SCOPE_HEIGHT_PERCENT;
  }
}

export function saveScopePanelBasis(value: number, storage: WritableStorage | undefined = browserStorage()): void {
  try {
    const clamped = Math.max(MIN_SCOPE_HEIGHT_PERCENT, Math.min(MAX_SCOPE_HEIGHT_PERCENT, value));
    storage?.setItem(SCOPE_HEIGHT_STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // Resizing remains available for the current session when storage is blocked or full.
  }
}
