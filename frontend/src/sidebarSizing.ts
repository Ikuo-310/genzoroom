export type SidebarSide = 'left' | 'right';
export type SidebarWidths = Record<SidebarSide, number>;

export const SIDEBAR_WIDTHS_STORAGE_KEY = 'genzoroom.anshitsu.sidebar-widths';
export const SIDEBAR_WIDTHS_VERSION = 1;
export const SIDEBAR_RESIZE_MEDIA_QUERY = '(min-width: 961px) and (pointer: fine)';
export const SIDEBAR_HANDLE_WIDTH = 6;
export const VIEWER_MIN_WIDTH = 360;
export const SIDEBAR_LIMITS = {
  left: { min: 210, max: 420, default: 240 },
  right: { min: 230, max: 440, default: 270 },
} as const;

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function defaultSidebarWidths(): SidebarWidths {
  return { left: SIDEBAR_LIMITS.left.default, right: SIDEBAR_LIMITS.right.default };
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function validStoredWidth(side: SidebarSide, value: unknown): value is number {
  const limits = SIDEBAR_LIMITS[side];
  return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max;
}

export function readSidebarWidths(storage: ReadableStorage | undefined = browserStorage()): SidebarWidths {
  const defaults = defaultSidebarWidths();
  try {
    const serialized = storage?.getItem(SIDEBAR_WIDTHS_STORAGE_KEY);
    if (!serialized) return defaults;
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== SIDEBAR_WIDTHS_VERSION) return defaults;
    const stored = value as { left?: unknown; right?: unknown };
    return {
      left: validStoredWidth('left', stored.left) ? stored.left : defaults.left,
      right: validStoredWidth('right', stored.right) ? stored.right : defaults.right,
    };
  } catch {
    return defaults;
  }
}

export function saveSidebarWidths(widths: SidebarWidths, storage: WritableStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(SIDEBAR_WIDTHS_STORAGE_KEY, JSON.stringify({ version: SIDEBAR_WIDTHS_VERSION, ...widths }));
  } catch {
    // Resizing remains available for the current session when storage is blocked or full.
  }
}

function clamp(side: SidebarSide, value: number): number {
  const limits = SIDEBAR_LIMITS[side];
  return Math.round(Math.max(limits.min, Math.min(limits.max, value)));
}

export function fitSidebarWidths(
  widths: SidebarWidths,
  containerWidth: number,
  leftOpen: boolean,
  rightOpen: boolean,
): SidebarWidths {
  let left = clamp('left', widths.left);
  let right = clamp('right', widths.right);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return { left, right };

  const openCount = Number(leftOpen) + Number(rightOpen);
  const available = Math.max(0, containerWidth - VIEWER_MIN_WIDTH - openCount * SIDEBAR_HANDLE_WIDTH);
  if (leftOpen && !rightOpen) left = Math.min(left, available);
  if (!leftOpen && rightOpen) right = Math.min(right, available);
  if (!leftOpen || !rightOpen || left + right <= available) return { left, right };

  const leftCapacity = left - SIDEBAR_LIMITS.left.min;
  const rightCapacity = right - SIDEBAR_LIMITS.right.min;
  const totalCapacity = leftCapacity + rightCapacity;
  const excess = left + right - available;
  if (totalCapacity <= 0) return { left, right };
  left = Math.max(SIDEBAR_LIMITS.left.min, Math.round(left - excess * leftCapacity / totalCapacity));
  right = Math.max(SIDEBAR_LIMITS.right.min, Math.floor(available - left));
  return { left, right };
}

export function clampResizedSidebar(
  side: SidebarSide,
  proposedWidth: number,
  containerWidth: number,
  otherWidth: number,
  otherOpen: boolean,
): number {
  const limits = SIDEBAR_LIMITS[side];
  const handleCount = otherOpen ? 2 : 1;
  const available = containerWidth - VIEWER_MIN_WIDTH - handleCount * SIDEBAR_HANDLE_WIDTH - (otherOpen ? otherWidth : 0);
  return Math.round(Math.max(limits.min, Math.min(limits.max, available, proposedWidth)));
}

export function sidebarResizeEnabled(matchMedia: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  try {
    return matchMedia?.matchMedia(SIDEBAR_RESIZE_MEDIA_QUERY).matches === true;
  } catch {
    return false;
  }
}
