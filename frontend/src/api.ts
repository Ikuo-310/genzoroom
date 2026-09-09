import type { AssetDetail, RecentAsset } from './assets';

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

export async function fetchRecentAssets(signal: AbortSignal): Promise<RecentAsset[]> {
  const response = await fetch('/api/assets/recent', { signal, cache: 'no-store' });
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
