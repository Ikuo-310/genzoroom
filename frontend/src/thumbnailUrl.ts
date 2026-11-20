import { frontendLogger } from './frontendLogging';

export function thumbnailDiagnosticUrl(url: string, diagnosticId: string): string {
  try { if (frontendLogger.getLevel() !== 'debug') return url; }
  catch { return url; }
  return `${url}${url.includes('?') ? '&' : '?'}__diag=${encodeURIComponent(diagnosticId)}`;
}

export type ThumbnailRendition = 'thumbnail' | 'rendered-thumbnail' | 'preview' | 'immersive-preview';

export function thumbnailSourceUrl(assetId: string, rendition: ThumbnailRendition, publicationVersion?: string | number | null): string {
  const url = `/api/assets/${encodeURIComponent(assetId)}/${rendition}`;
  return (rendition === 'rendered-thumbnail' || rendition === 'immersive-preview')
    && publicationVersion !== undefined && publicationVersion !== null
    ? `${url}?publication=${encodeURIComponent(String(publicationVersion))}` : url;
}
