import { decodeEditSource } from './editImageSource';
import { compareRgbPixels, type DecodeStatistics, type RgbPixelBuffer } from './decodeComparison';
import { DecodeComparisonError, EncodeRoundTripError, fetchExportEngineRoundTrip, type EncodeRoundTripSource } from './exportEngineApi';
import { ENCODE_ROUNDTRIP_ERRORS, type EncodeRoundTripErrorCode } from './exportEngineApi';

export const ROUNDTRIP_DIRECTION_DEADBAND = 0.35;
// JPEG quality 95 is intentionally assessed with broad byte-domain bands pending real-image measurements.
export const ROUNDTRIP_MINIMAL_MAE = 4;
export const ROUNDTRIP_NOTICEABLE_MAE = 12;
export type EncodeRoundTripAssessment = { brightnessDirection: 'brighter' | 'darker' | 'neutral';
  tintDirection: 'green' | 'magenta' | 'neutral'; differenceLevel: 'minimal' | 'small' | 'noticeable' };
export type EncodeRoundTripReport = {
  status: 'not_run' | 'running' | 'completed' | 'failed' | 'cancelled'; error: EncodeRoundTripErrorCode | null;
  dimensions: { preEncode: { width: number; height: number } | null; decodedJpeg: { width: number; height: number } | null };
  sourceIcc: 'embedded' | 'absent' | null; recipeVersion: 18 | null; quality: 95 | null;
  subsampling: '4:4:4' | null; outputColorSpace: 'sRGB' | null;
  timing: { renderMs: number | null; encodeMs: number | null; jpegDecodeMs: number | null;
    backendRequestMs: number | null; comparisonMs: number | null; totalMs: number | null };
  statistics: DecodeStatistics | null; assessment: EncodeRoundTripAssessment | null;
};
export type EncodeRoundTripPhase = 'idle' | 'backend' | 'jpeg_decode' | 'comparison';
export interface EncodeRoundTripDependencies {
  backend: typeof fetchExportEngineRoundTrip; decode: typeof decodeEditSource; yield: () => Promise<void>;
}
const yieldToUi = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
export const emptyEncodeRoundTrip = (): EncodeRoundTripReport => ({
  status: 'not_run', error: null, dimensions: { preEncode: null, decodedJpeg: null }, sourceIcc: null, recipeVersion: null,
  quality: null, subsampling: null, outputColorSpace: null,
  timing: { renderMs: null, encodeMs: null, jpegDecodeMs: null, backendRequestMs: null, comparisonMs: null, totalMs: null },
  statistics: null, assessment: null,
});

export function assessEncodeRoundTrip(stats: DecodeStatistics): EncodeRoundTripAssessment {
  const brightnessDirection = stats.meanLumaDelta > ROUNDTRIP_DIRECTION_DEADBAND ? 'brighter'
    : stats.meanLumaDelta < -ROUNDTRIP_DIRECTION_DEADBAND ? 'darker' : 'neutral';
  const tintDirection = stats.greenBias > ROUNDTRIP_DIRECTION_DEADBAND ? 'green'
    : stats.greenBias < -ROUNDTRIP_DIRECTION_DEADBAND ? 'magenta' : 'neutral';
  const differenceLevel = stats.meanAbsoluteError < ROUNDTRIP_MINIMAL_MAE ? 'minimal'
    : stats.meanAbsoluteError < ROUNDTRIP_NOTICEABLE_MAE ? 'small' : 'noticeable';
  return { brightnessDirection, tintDirection, differenceLevel };
}

export async function runEncodeRoundTrip(assetId: string, expectedRevision: number, signal: AbortSignal,
  phase: (value: EncodeRoundTripPhase) => void, dependencies: Partial<EncodeRoundTripDependencies> = {}): Promise<EncodeRoundTripReport> {
  const deps = { backend: fetchExportEngineRoundTrip, decode: decodeEditSource, yield: yieldToUi, ...dependencies };
  const report = emptyEncodeRoundTrip(); report.status = 'running';
  const started = performance.now(); let result: EncodeRoundTripSource | null = null;
  let image: ImageData | null = null, objectUrl: string | null = null, generatedJpeg: Blob | null = null;
  let preEncodePixels: Uint8Array | null = null, metadata: EncodeRoundTripSource['metadata'] | null = null;
  let code: EncodeRoundTripErrorCode = 'backend_unavailable';
  const releaseUrl = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  signal.addEventListener('abort', releaseUrl, { once: true });
  try {
    if (!assetId) throw new EncodeRoundTripError('no_asset_selected');
    signal.throwIfAborted(); phase('backend'); code = 'backend_unavailable';
    let timer = performance.now();
    try { result = await deps.backend(assetId, expectedRevision, signal); signal.throwIfAborted(); }
    finally { report.timing.backendRequestMs = performance.now() - timer; }
    metadata = result.metadata; generatedJpeg = result.jpeg; preEncodePixels = result.pixels; result = null;
    report.dimensions.preEncode = { width: metadata.outputWidth, height: metadata.outputHeight };
    report.sourceIcc = metadata.sourceIcc; report.recipeVersion = metadata.recipeVersion;
    report.quality = metadata.quality; report.subsampling = metadata.subsampling;
    report.outputColorSpace = metadata.outputColorSpace;
    report.timing.renderMs = metadata.renderMs; report.timing.encodeMs = metadata.encodeMs;
    phase('jpeg_decode'); code = 'jpeg_decode_failed'; timer = performance.now();
    objectUrl = URL.createObjectURL(generatedJpeg);
    try { image = await deps.decode({ kind: 'jpeg-original', url: objectUrl }, signal); signal.throwIfAborted(); }
    finally { report.timing.jpegDecodeMs = performance.now() - timer; releaseUrl(); generatedJpeg = null; }
    report.dimensions.decodedJpeg = { width: image.width, height: image.height };
    phase('comparison'); signal.throwIfAborted(); code = 'invalid_rgb_response'; timer = performance.now();
    try {
      await deps.yield(); signal.throwIfAborted();
      const reference: RgbPixelBuffer = { width: metadata!.outputWidth, height: metadata!.outputHeight,
        pixels: preEncodePixels!, stride: 3 };
      const decoded: RgbPixelBuffer = { width: image.width, height: image.height, pixels: image.data, stride: 4 };
      report.statistics = await compareRgbPixels(reference, decoded, signal, deps.yield);
    } finally { report.timing.comparisonMs = performance.now() - timer; }
    report.assessment = assessEncodeRoundTrip(report.statistics); report.status = 'completed';
  } catch (failure) {
    report.status = signal.aborted ? 'cancelled' : 'failed';
    report.error = signal.aborted ? 'cancelled' : failure instanceof DecodeComparisonError
      ? failure.code === 'dimension_mismatch' ? 'dimension_mismatch' : 'invalid_rgb_response'
      : failure instanceof EncodeRoundTripError && ENCODE_ROUNDTRIP_ERRORS.includes(failure.code) ? failure.code : code;
  } finally {
    image = null; result = null; generatedJpeg = null; preEncodePixels = null; metadata = null;
    releaseUrl(); signal.removeEventListener('abort', releaseUrl);
    report.timing.totalMs = performance.now() - started;
  }
  return report;
}
