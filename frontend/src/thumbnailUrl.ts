import type { RecentAsset } from './assets';
import { frontendLogger } from './frontendLogging';

export function thumbnailDiagnosticUrl(url: string, diagnosticId: string): string {
  if (frontendLogger.getLevel() !== 'debug') return url;
  return `${url}${url.includes('?') ? '&' : '?'}__diag=${encodeURIComponent(diagnosticId)}`;
}

export function thumbnailUrl(asset: Pick<RecentAsset, 'id' | 'thumbnail_url'>, edited = true, refreshKey?: string): string {
  if (!edited) return asset.thumbnail_url;
  // Backend saved-state eligibility and fallback apply equally to RAW and JPEG, regardless of UI badges.
  const url = `/api/assets/${encodeURIComponent(asset.id)}/rendered-thumbnail`;
  return refreshKey === undefined ? url : `${url}?view=${encodeURIComponent(refreshKey)}`;
}
