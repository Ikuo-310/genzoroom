import type { RegionRect, RegionWindow } from './rawRegionPlanner';

export const RAW_REGION_DIAGNOSTICS_CHANNEL = 'genzoroom-raw-region-diagnostics';
export type RawRegionPosition = 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'left' | 'right' | 'top' | 'bottom';
export type RawRegionDiagnosticState = {
  connected: boolean; supported: boolean | null; wholeQuality: 'draft' | 'full' | null;
  wholeGeometry: string | null; regionGeometry: string | null; geometryMatches: boolean | null;
  regionSize: { width: number; height: number } | null; displayed: boolean; beforeReady: boolean;
  comparing: boolean; position: RawRegionPosition | null; requesting: boolean; cleared: boolean;
  errorCode?: string; frame?: { nativeWidth: number; nativeHeight: number };
  ownerErrorCode?: string; ownerHttpStatus?: number;
  details?: { f: { fullWidth: number; fullHeight: number }; w: RegionWindow; validRegion: RegionWindow; revision: number; viewGeneration: number;
    planGeneration: number; requestId: string } | null;
};
export type RawRegionDiagnosticMessage =
  | { type: 'attach' | 'detach' | 'state.request'; clientId: string }
  | { type: 'action'; clientId: string; ownerId?: string; actionId: string; action: 'request'; position: RawRegionPosition; compare: boolean }
  | { type: 'action'; clientId: string; ownerId?: string; actionId: string; action: 'clear' }
  | { type: 'action'; clientId: string; ownerId?: string; actionId: string; action: 'outline'; enabled: boolean }
  | { type: 'state'; clientId: string; ownerId: string; state: RawRegionDiagnosticState }
  | { type: 'result'; clientId: string; ownerId: string; actionId: string; ok: boolean; errorCode?: string };

export type RawRegionDiagnosticsChannel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;
// /developer may be opened in a separate WebView from the RAW darkroom.
export function createRawRegionDiagnosticsChannel(name = RAW_REGION_DIAGNOSTICS_CHANNEL): RawRegionDiagnosticsChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
}

export function diagnosticVisibleRect(position: RawRegionPosition, width: number, height: number): RegionRect {
  const w = width / 2, h = height / 2;
  const x0 = position.endsWith('Left') ? 0 : position.endsWith('Right') ? width - w
    : position === 'left' ? 0 : position === 'right' ? width - w : (width - w) / 2;
  const y0 = position.startsWith('top') && position !== 'top' ? 0 : position.startsWith('bottom') && position !== 'bottom'
    ? height - h : position === 'top' ? 0 : position === 'bottom' ? height - h : (height - h) / 2;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function rawRegionDiagnosticError(code: string) {
  const known: Record<string, string> = {
    raw_region_unavailable: 'capability', raw_region_whole_waiting: 'wholeWaiting', raw_region_pair_waiting: 'beforeWaiting',
    raw_region_geometry_mismatch: 'geometryMismatch', raw_region_cancelled: 'cancelled', raw_region_timeout: 'requestFailed',
    raw_region_rejected: 'requestFailed', raw_connection_failed: 'requestFailed', raw_region_decode_dimensions: 'requestFailed',
    raw_region_decode_failed: 'requestFailed', raw_region_pair_mismatch: 'geometryMismatch',
    raw_region_owner_failed: 'ownerFailed',
  };
  return known[code] ?? 'requestFailed';
}
