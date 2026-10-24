import type { RegionRequest, RegionResponse } from '../rawRegionContract';

export function regionRequest(overrides: Partial<RegionRequest> = {}): RegionRequest {
  return { contractVersion: 1, mode: 'region', quality: 'full', geometryId: 'a'.repeat(64), fullWidth: 4000, fullHeight: 3000,
    window: { x: 1000, y: 800, w: 1000, h: 800 }, validRegion: { x: 1016, y: 816, w: 968, h: 768 }, context: 16, prefetch: 8,
    identity: { assetId: '12345678-1234-4234-9234-123456789abc', sourceId: 'b'.repeat(64), generation: 1,
      documentToken: 'c'.repeat(32), kind: 'after', revision: 2 }, documentRevision: 2, viewGeneration: 3, requestId: 'd'.repeat(32), ...overrides };
}
export const regionResponse = (r = regionRequest()): RegionResponse => ({ ...r, kind: r.identity.kind, width: r.window.w, height: r.window.h });
