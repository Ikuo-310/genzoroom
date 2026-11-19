import type { RecentAsset } from './assets';
import { frontendLogger } from './frontendLogging';

export function thumbnailDiagnosticUrl(url: string, diagnosticId: string): string {
  try { if (frontendLogger.getLevel() !== 'debug') return url; }
  catch { return url; }
  return `${url}${url.includes('?') ? '&' : '?'}__diag=${encodeURIComponent(diagnosticId)}`;
}

export type ThumbnailRendition = 'thumbnail' | 'rendered-thumbnail' | 'preview' | 'immersive-preview';

export function thumbnailSourceUrl(assetId: string, rendition: ThumbnailRendition, revision?: string): string {
  const url = `/api/assets/${encodeURIComponent(assetId)}/${rendition}`;
  return rendition === 'rendered-thumbnail' && revision !== undefined ? `${url}?view=${encodeURIComponent(revision)}` : url;
}

export function thumbnailUrl(asset: Pick<RecentAsset, 'id' | 'thumbnail_url'>, edited = true, refreshKey?: string): string {
  if (!edited) return asset.thumbnail_url;
  // Backend saved-state eligibility and fallback apply equally to RAW and JPEG, regardless of UI badges.
  return thumbnailSourceUrl(asset.id, 'rendered-thumbnail', refreshKey);
}
