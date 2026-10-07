export const EXPORT_ENGINE_ERRORS = ['candidate_load_failed', 'saved_recipe_unavailable', 'unsupported_recipe_version',
  'saved_recipe_changed', 'original_fetch_failed', 'decode_failed', 'invalid_icc', 'render_failed', 'encode_failed',
  'backend_unavailable'] as const;
export type ExportEngineErrorCode = typeof EXPORT_ENGINE_ERRORS[number];
export class ExportEngineDiagnosticError extends Error {
  constructor(readonly code: ExportEngineErrorCode) { super(code); }
}
export type ExportEngineMetadata = {
  sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number;
  sourceIcc: 'embedded' | 'absent'; outputColorSpace: 'sRGB'; recipeVersion: 18;
  outputBytes: number; decodeMs: number; renderMs: number; encodeMs: number; totalMs: number;
  quality: 95; subsampling: '4:4:4';
};

export async function fetchExportEngineJpeg(assetId: string, expectedRevision: number, signal: AbortSignal): Promise<{ blob: Blob; metadata: ExportEngineMetadata }> {
  let response: Response;
  try {
    response = await fetch('/api/developer/export-engine', {
      method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId, expectedRevision }),
    });
  } catch { signal.throwIfAborted(); throw new ExportEngineDiagnosticError('backend_unavailable'); }
  signal.throwIfAborted();
  if (!response.ok) {
    let code: ExportEngineErrorCode = 'backend_unavailable';
    try {
      const body = await response.json();
      if (EXPORT_ENGINE_ERRORS.includes(body?.detail?.code)) code = body.detail.code;
    } catch { /* Only allowlisted codes are exposed, never server or proxy text. */ }
    throw new ExportEngineDiagnosticError(code);
  }
  try {
    if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'image/jpeg') throw new Error();
    const value = JSON.parse(response.headers.get('X-GenzoRoom-Export-Engine') ?? 'null');
    const integers = ['sourceWidth', 'sourceHeight', 'outputWidth', 'outputHeight', 'outputBytes'] as const;
    const times = ['decodeMs', 'renderMs', 'encodeMs', 'totalMs'] as const;
    if (!value || integers.some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
      || times.some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)
      || !['embedded', 'absent'].includes(value.sourceIcc) || value.outputColorSpace !== 'sRGB'
      || value.recipeVersion !== 18 || value.quality !== 95 || value.subsampling !== '4:4:4') throw new Error();
    // Reconstruct only safe technical fields; no extra headers can enter diagnostic state.
    const metadata: ExportEngineMetadata = {
      sourceWidth: value.sourceWidth, sourceHeight: value.sourceHeight,
      outputWidth: value.outputWidth, outputHeight: value.outputHeight,
      outputBytes: value.outputBytes, sourceIcc: value.sourceIcc, outputColorSpace: 'sRGB', recipeVersion: 18,
      decodeMs: value.decodeMs, renderMs: value.renderMs, encodeMs: value.encodeMs, totalMs: value.totalMs,
      quality: 95, subsampling: '4:4:4',
    };
    const blob = await response.blob();
    signal.throwIfAborted();
    if (blob.size !== metadata.outputBytes) throw new Error();
    return { blob, metadata };
  } catch { signal.throwIfAborted(); throw new ExportEngineDiagnosticError('backend_unavailable'); }
}

export const DECODE_COMPARE_ERRORS = ['no_asset_selected', 'original_fetch_failed', 'backend_unavailable',
  'backend_decode_failed', 'frontend_decode_failed', 'dimension_mismatch', 'invalid_binary_response', 'cancelled'] as const;
export type DecodeComparisonErrorCode = typeof DECODE_COMPARE_ERRORS[number];
export class DecodeComparisonError extends Error {
  constructor(readonly code: DecodeComparisonErrorCode) { super(code); }
}
export type BackendDecodeMetadata = {
  width: number; height: number; sourceWidth: number; sourceHeight: number;
  pixelFormat: 'rgb8'; sourceIcc: 'embedded' | 'absent'; orientationNormalized: true; backendDecodeMs: number;
};
export type BackendDecodedImage = { pixels: Uint8Array; metadata: BackendDecodeMetadata };

export async function fetchBackendDecode(assetId: string, signal: AbortSignal): Promise<BackendDecodedImage> {
  let response: Response;
  try {
    response = await fetch('/api/developer/export-engine/decode', {
      method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId }),
    });
  } catch { signal.throwIfAborted(); throw new DecodeComparisonError('backend_unavailable'); }
  signal.throwIfAborted();
  if (!response.ok) {
    let code: DecodeComparisonErrorCode = 'backend_unavailable';
    try {
      const body = await response.json();
      if (DECODE_COMPARE_ERRORS.includes(body?.detail?.code)) code = body.detail.code;
    } catch { /* Proxy and backend exception text must never enter the report. */ }
    signal.throwIfAborted();
    throw new DecodeComparisonError(code);
  }
  try {
    if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/octet-stream') throw new Error();
    const header = response.headers.get('X-GenzoRoom-Decode');
    if (!header || header.length > 1024) throw new Error();
    const value = JSON.parse(header);
    if (!value || ['width', 'height', 'sourceWidth', 'sourceHeight'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
      || !Number.isSafeInteger(value.width * value.height * 3) || value.pixelFormat !== 'rgb8'
      || !['embedded', 'absent'].includes(value.sourceIcc) || value.orientationNormalized !== true
      || typeof value.backendDecodeMs !== 'number' || !Number.isFinite(value.backendDecodeMs) || value.backendDecodeMs < 0) throw new Error();
    const pixels = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    if (pixels.length !== value.width * value.height * 3) throw new Error();
    return { pixels, metadata: { width: value.width, height: value.height,
      sourceWidth: value.sourceWidth, sourceHeight: value.sourceHeight, pixelFormat: 'rgb8', sourceIcc: value.sourceIcc,
      orientationNormalized: true, backendDecodeMs: value.backendDecodeMs } };
  } catch { signal.throwIfAborted(); throw new DecodeComparisonError('invalid_binary_response'); }
}
