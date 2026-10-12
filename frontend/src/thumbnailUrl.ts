import type { RecentAsset } from './assets';

export function thumbnailUrl(asset: Pick<RecentAsset, 'id' | 'thumbnail_url'>, edited = true, refreshKey?: string): string {
  if (!edited) return asset.thumbnail_url;
  const url = `/api/assets/${encodeURIComponent(asset.id)}/rendered-thumbnail`;
  return refreshKey === undefined ? url : `${url}?view=${encodeURIComponent(refreshKey)}`;
}
