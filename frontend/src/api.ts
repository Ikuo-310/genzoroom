import type { AssetDetail, RecentAsset } from './assets';
import type { AlbumSummary } from './albums';
import type { CalendarHeatmap } from './HomeCalendar';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRecentAsset(value: unknown): value is RecentAsset {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.date === 'string' &&
    typeof value.thumbnail_url === 'string' &&
    typeof value.format === 'string' &&
    typeof value.is_raw === 'boolean';
}

function isAssetDetail(value: unknown): value is AssetDetail {
  if (!isRecentAsset(value)) return false;
  const detail = value as RecentAsset & Record<string, unknown>;
  return typeof detail.preview_url === 'string' && isRecord(detail.exif);
}

function isAlbumSummary(value: unknown): value is AlbumSummary {
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
  if (!Array.isArray(data) || data.some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected album assets response');
  }
  return data;
}

export async function fetchCalendarHeatmap(year: number, month: number, signal: AbortSignal): Promise<CalendarHeatmap> {
  const response = await fetch(`/api/calendar/heatmap?year=${year}&month=${month}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar heatmap request failed');
  const data: unknown = await response.json();
  if (!isRecord(data) || data.year !== year || data.month !== month || !Array.isArray(data.days) ||
    data.days.some(day => !isRecord(day) || typeof day.date !== 'string' || typeof day.hasAssets !== 'boolean')) {
    throw new Error('Unexpected calendar heatmap response');
  }
  return data as CalendarHeatmap;
}

export async function fetchCalendarDayAssets(day: string, signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch(`/api/calendar/${encodeURIComponent(day)}/assets`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Calendar photos request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.some(asset => !isRecentAsset(asset))) {
    throw new Error('Unexpected calendar photos response');
  }
  return data;
}

export async function fetchRecentAssets(limit: number, signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch(`/api/assets/recent?limit=${limit}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Recent assets request failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.some((asset) => !isRecentAsset(asset))) {
    throw new Error('Unexpected recent assets response');
  }
  return data;
}

export async function fetchAssetDetail(assetId: string, signal: AbortSignal): Promise<AssetDetail> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Asset detail request failed');
  const data: unknown = await response.json();
  if (!isAssetDetail(data)) throw new Error('Unexpected asset detail response');
  return data;
}
