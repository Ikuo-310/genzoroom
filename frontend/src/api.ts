import type { AssetDetail, RecentAsset, ImmichStack } from './assets';
import type { AlbumSummary } from './albums';
import type { CalendarHeatmap } from './HomeCalendar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type ImmichStacksErrorCode = 'request_failed' | 'unexpected_stack_response' | 'singleton_stack'
  | 'requested_stack_missing' | 'selected_member_missing' | 'unexpected_stack_refresh';
export interface ImmichStacksErrorDetails {
  stackId?: string;
  primaryAssetId?: string;
  memberCount?: number;
  memberIds?: string[];
  missingStackIds?: string[];
  httpStatus?: number;
}
export class ImmichStacksError extends Error {
  constructor(readonly code: ImmichStacksErrorCode, readonly details: ImmichStacksErrorDetails = {}, message = 'Unexpected stacks response') {
    super(message);
    this.name = 'ImmichStacksError';
  }
}

export function isRecentAsset(value: unknown): value is RecentAsset {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.date === 'string' &&
    typeof value.thumbnail_url === 'string' &&
    typeof value.format === 'string' &&
    typeof value.is_raw === 'boolean' &&
    ((value.stackId == null && value.primaryAssetId == null) ||
      (isUuid(value.stackId) && isUuid(value.primaryAssetId))) &&
    (value.stackAssetCount == null ||
      (typeof value.stackAssetCount === 'number' && Number.isSafeInteger(value.stackAssetCount) && value.stackAssetCount >= 2));
}

function withSafeStackCounts(data: unknown[]): unknown[] {
  return data.map(value => {
    if (!isRecord(value) || value.stackAssetCount == null ||
      typeof value.stackAssetCount === 'number' && Number.isSafeInteger(value.stackAssetCount) && value.stackAssetCount >= 2) {
      return value;
    }
    // A bad optional count should hide only the Stack label, never the photo itself.
    return { ...value, stackAssetCount: null };
  });
}

function isAssetDetail(value: unknown): value is AssetDetail {
  if (!isRecentAsset(value)) return false;
  const detail = value as RecentAsset & Record<string, unknown>;
  return typeof detail.preview_url === 'string' && isRecord(detail.exif);
}

export function isAlbumSummary(value: unknown): value is AlbumSummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.albumName === 'string' &&
    (value.albumThumbnailAssetId === null || typeof value.albumThumbnailAssetId === 'string') &&
    typeof value.assetCount === 'number' && Number.isInteger(value.assetCount) && value.assetCount >= 0 &&
    (value.startDate === null || typeof value.startDate === 'string') &&
    (value.endDate === null || typeof value.endDate === 'string');
}

export async function fetchAlbums(signal: AbortSignal): Promise<AlbumSummary[]> {
  const response = await fetch('/api/albums', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Albums request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.some(album => !isAlbumSummary(album))) {
    throw new Error('Unexpected albums response');
  }
  return data;
}

export async function fetchAlbumAssets(albumId: string, signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch(`/api/albums/${encodeURIComponent(albumId)}/assets`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Album assets request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || withSafeStackCounts(data).some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected album assets response');
  }
  return withSafeStackCounts(data) as RecentAsset[];
}

export async function fetchCalendarHeatmap(year: number, month: number | null, signal: AbortSignal): Promise<CalendarHeatmap> {
  const response = await fetch(`/api/calendar/heatmap?year=${year}${month === null ? '' : `&month=${month}`}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar heatmap request failed');
  const data: unknown = await response.json();
  if (!isRecord(data) || data.year !== year || data.month !== month || !Array.isArray(data.days) ||
    data.days.some(day => !isRecord(day) || typeof day.date !== 'string' || typeof day.hasAssets !== 'boolean' ||
      typeof day.count !== 'number' || !Number.isSafeInteger(day.count) || day.count < 0 ||
      !(day.thumbnail_url === undefined || day.thumbnail_url === null || typeof day.thumbnail_url === 'string'))) {
    throw new Error('Unexpected calendar heatmap response');
  }
  return data as CalendarHeatmap;
}

export async function fetchCalendarMinYear(signal: AbortSignal): Promise<number | null> {
  const response = await fetch('/api/calendar/min-year', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar minimum year request failed');
  const data: unknown = await response.json();
  if (!isRecord(data) || !(data.minYear === null ||
    typeof data.minYear === 'number' && Number.isInteger(data.minYear) && data.minYear >= 1 && data.minYear <= 9999)) {
    throw new Error('Unexpected calendar minimum year response');
  }
  return data.minYear;
}

export async function fetchCalendarDayAssets(day: string, signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch(`/api/calendar/${encodeURIComponent(day)}/assets`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar photos request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || withSafeStackCounts(data).some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected calendar photos response');
  }
  return withSafeStackCounts(data) as RecentAsset[];
}

export async function fetchFavoriteAssets(signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch('/api/assets/favorites', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Favorites request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || withSafeStackCounts(data).some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected favorites response');
  }
  return withSafeStackCounts(data) as RecentAsset[];
}

export async function fetchRecentAssets(limit: number, signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch(`/api/assets/recent?limit=${limit}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Recent assets request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || withSafeStackCounts(data).some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected recent assets response');
  }
  return withSafeStackCounts(data) as RecentAsset[];
}

export async function fetchAssetDetail(assetId: string, signal: AbortSignal): Promise<AssetDetail> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Asset detail request failed');
  const data: unknown = await response.json();
  if (!isAssetDetail(data)) throw new Error('Unexpected asset detail response');
  // Optional malformed GPS must not turn a readable photo into a fatal detail error.
  const coordinate = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
  return { ...data, exif: { ...data.exif, latitude: coordinate(data.exif.latitude, 90), longitude: coordinate(data.exif.longitude, 180) } };
}

export function validateImmichStacks(data: unknown, requestedIds?: readonly string[]): ImmichStack[] {
  const requested = requestedIds ? new Set(requestedIds.map(id => id.toLowerCase())) : null;
  const stacks = new Set<string>(), members = new Set<string>();
  if (!Array.isArray(data)) throw new ImmichStacksError('unexpected_stack_response');
  for (const stack of data) {
    if (!isRecord(stack) || !isUuid(stack.id) || !isUuid(stack.primaryAssetId)
      || (requested !== null && !requested.has(stack.id.toLowerCase())) || stacks.has(stack.id.toLowerCase())
      || !Array.isArray(stack.assets)) throw new ImmichStacksError('unexpected_stack_response');
    if (stack.assets.length === 1) {
      const member = stack.assets[0];
      throw new ImmichStacksError('singleton_stack', { stackId: stack.id.toLowerCase(), primaryAssetId: stack.primaryAssetId.toLowerCase(),
        memberCount: 1, memberIds: isRecord(member) && isUuid(member.id) ? [member.id.toLowerCase()] : [] });
    }
    if (stack.assets.length < 2) throw new ImmichStacksError('unexpected_stack_response');
    stacks.add(stack.id.toLowerCase());
    for (const asset of stack.assets) {
      if (!isRecentAsset(asset) || !isUuid(asset.id) || members.has(asset.id.toLowerCase())
        || asset.stackId?.toLowerCase() !== stack.id.toLowerCase()
        || asset.primaryAssetId?.toLowerCase() !== stack.primaryAssetId.toLowerCase()
        || asset.stackAssetCount !== stack.assets.length) throw new ImmichStacksError('unexpected_stack_response');
      members.add(asset.id.toLowerCase());
    }
    if (!stack.assets.some((asset: RecentAsset) => asset.id.toLowerCase() === (stack.primaryAssetId as string).toLowerCase())) throw new ImmichStacksError('unexpected_stack_response');
  }
  if (requested !== null) {
    const missingStackIds = [...requested].filter(id => !stacks.has(id));
    if (missingStackIds.length) throw new ImmichStacksError('requested_stack_missing', { missingStackIds });
  }
  // UUID casing must not leave a valid primary unmatched by case-sensitive UI IDs.
  return (data as ImmichStack[]).map(stack => ({ ...stack, id: stack.id.toLowerCase(), primaryAssetId: stack.primaryAssetId.toLowerCase(),
    assets: stack.assets.map(asset => ({ ...asset, id: asset.id.toLowerCase(), stackId: stack.id.toLowerCase(), primaryAssetId: stack.primaryAssetId.toLowerCase() })) }));
}

export async function fetchSelectedImmichStacks(stackIds: readonly string[], signal: AbortSignal): Promise<ImmichStack[]> {
  if (stackIds.length > 100 || stackIds.some(id => !isUuid(id))) throw new Error('Invalid stack IDs');
  const ids = [...new Set(stackIds.map(id => id.toLowerCase()))];
  if (!ids.length) return [];
  const response = await fetch('/api/stacks/resolve', { method: 'POST', signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stackIds: ids }) });
  if (!response.ok) throw new ImmichStacksError('request_failed', { httpStatus: response.status }, 'Stacks request failed');
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ImmichStacksError('unexpected_stack_response'); }
  return validateImmichStacks(data, ids);
}

export async function refreshSelectedImmichStacks(assetIds: readonly string[], signal: AbortSignal): Promise<ImmichStack[]> {
  if (assetIds.some(id => !isUuid(id))) throw new Error('Invalid asset IDs');
  const uniqueAssets = [...new Set(assetIds.map(id => id.toLowerCase()))];
  if (!uniqueAssets.length) return [];
  const byId = new Map<string, ImmichStack>();
  for (let start = 0; start < uniqueAssets.length; start += 1000) {
    const chunk = uniqueAssets.slice(start, start + 1000);
    const response = await fetch('/api/stacks/refresh', { method: 'POST', signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: chunk }) });
    if (!response.ok) throw new ImmichStacksError('request_failed', { httpStatus: response.status }, 'Stacks refresh failed');
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ImmichStacksError('unexpected_stack_response'); }
    const stacks = validateImmichStacks(data);
    for (const stack of stacks) {
      const previous = byId.get(stack.id);
      // A Stack selected on both sides of a chunk boundary must resolve to the same full snapshot.
      if (previous && stackSignature(previous) !== stackSignature(stack)) throw new ImmichStacksError('unexpected_stack_refresh', {}, 'Unexpected stacks refresh');
      if (!previous) byId.set(stack.id, stack);
    }
  }
  const stacks = validateImmichStacks([...byId.values()]);
  const ids = new Set(assetIds.map(id => id.toLowerCase()));
  if (stacks.some(stack => !stack.assets.some(asset => ids.has(asset.id)))) throw new ImmichStacksError('unexpected_stack_refresh', {}, 'Unexpected stacks refresh');
  return stacks;
}

function stackSignature(stack: ImmichStack): string {
  return JSON.stringify({ id: stack.id, primaryAssetId: stack.primaryAssetId,
    assets: [...stack.assets].sort((a, b) => a.id.localeCompare(b.id)).map(asset => ({ id: asset.id, filename: asset.filename,
      date: asset.date, thumbnail_url: asset.thumbnail_url, format: asset.format, is_raw: asset.is_raw,
      stackId: asset.stackId, primaryAssetId: asset.primaryAssetId, stackAssetCount: asset.stackAssetCount })) });
}
