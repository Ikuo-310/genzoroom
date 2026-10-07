import { decodeEditSource } from './editImageSource';
import { DecodeComparisonError, fetchBackendDecode, type BackendDecodedImage, type DecodeComparisonErrorCode } from './exportEngineApi';

export const COMPARISON_CHUNK_PIXELS = 65536;
// These byte-unit thresholds describe tendencies only; they are not color-quality acceptance limits.
export const DIRECTION_DEADBAND = 0.1;
export const MINIMAL_DIFFERENCE_MAE = 0.5;
export const NOTICEABLE_DIFFERENCE_MAE = 2;
export type DecodeAssessment = {
  brightnessDirection: 'brighter' | 'darker' | 'neutral'; tintDirection: 'green' | 'magenta' | 'neutral';
  differenceLevel: 'minimal' | 'small' | 'noticeable';
};
export type DecodeStatistics = {
  meanDeltaR: number; meanDeltaG: number; meanDeltaB: number;
  meanAbsoluteDeltaR: number; meanAbsoluteDeltaG: number; meanAbsoluteDeltaB: number;
  maxAbsoluteDeltaR: number; maxAbsoluteDeltaG: number; maxAbsoluteDeltaB: number;
  meanAbsoluteError: number; rmse: number; exactMatchPixelPercent: number;
  pixelsAtLeast1Percent: number; pixelsAtLeast2Percent: number; pixelsAtLeast4Percent: number; pixelsAtLeast8Percent: number;
  meanLumaDelta: number; greenBias: number;
};
export type DecodeComparisonReport = {
  status: 'not_run' | 'running' | 'completed' | 'failed' | 'cancelled'; error: DecodeComparisonErrorCode | null;
  dimensions: { frontend: { width: number; height: number } | null; backend: { width: number; height: number } | null };
  sourceIcc: 'embedded' | 'absent' | null; orientationNormalized: boolean | null;
  timing: { frontendDecodeMs: number | null; backendDecodeMs: number | null; backendRequestMs: number | null;
    comparisonMs: number | null; totalMs: number | null };
  statistics: DecodeStatistics | null; assessment: DecodeAssessment | null;
};
export type DecodePhase = 'idle' | 'original' | 'frontend' | 'backend' | 'comparison';
export interface DecodeComparisonDependencies {
  decode: typeof decodeEditSource; backend: typeof fetchBackendDecode;
  fetch: typeof fetch; yield: () => Promise<void>;
}
const yieldToUi = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
export const emptyDecodeComparison = (): DecodeComparisonReport => ({
  status: 'not_run', error: null, dimensions: { frontend: null, backend: null }, sourceIcc: null, orientationNormalized: null,
  timing: { frontendDecodeMs: null, backendDecodeMs: null, backendRequestMs: null, comparisonMs: null, totalMs: null },
  statistics: null, assessment: null,
});

export function assessDecodeDifference(stats: DecodeStatistics): DecodeAssessment {
  return {
    brightnessDirection: stats.meanLumaDelta > DIRECTION_DEADBAND ? 'brighter' : stats.meanLumaDelta < -DIRECTION_DEADBAND ? 'darker' : 'neutral',
    tintDirection: stats.greenBias > DIRECTION_DEADBAND ? 'green' : stats.greenBias < -DIRECTION_DEADBAND ? 'magenta' : 'neutral',
    differenceLevel: stats.meanAbsoluteError < MINIMAL_DIFFERENCE_MAE ? 'minimal'
      : stats.meanAbsoluteError < NOTICEABLE_DIFFERENCE_MAE ? 'small' : 'noticeable',
  };
}

export async function compareDecodedPixels(frontend: Pick<ImageData, 'width' | 'height' | 'data'>,
  backend: BackendDecodedImage, signal: AbortSignal, yieldControl = yieldToUi): Promise<DecodeStatistics> {
  signal.throwIfAborted();
  if (frontend.width !== backend.metadata.width || frontend.height !== backend.metadata.height) {
    throw new DecodeComparisonError('dimension_mismatch');
  }
  const count = frontend.width * frontend.height;
  if (!Number.isSafeInteger(count) || count < 1 || frontend.data.length !== count * 4 || backend.pixels.length !== count * 3) {
    throw new DecodeComparisonError('invalid_binary_response');
  }
  const signed = [0, 0, 0], absolute = [0, 0, 0], maxima = [0, 0, 0], thresholds = [0, 0, 0, 0];
  let squared = 0, exact = 0;
  // Accumulate directly from byte buffers: no full-image float or difference arrays.
  for (let start = 0; start < count; start += COMPARISON_CHUNK_PIXELS) {
    signal.throwIfAborted();
    const end = Math.min(count, start + COMPARISON_CHUNK_PIXELS);
    for (let pixel = start; pixel < end; pixel++) {
      let max = 0;
      for (let channel = 0; channel < 3; channel++) {
        const delta = backend.pixels[pixel * 3 + channel] - frontend.data[pixel * 4 + channel];
        const magnitude = Math.abs(delta);
        signed[channel] += delta; absolute[channel] += magnitude; squared += delta * delta;
        maxima[channel] = Math.max(maxima[channel], magnitude); max = Math.max(max, magnitude);
      }
      if (max === 0) exact++;
      if (max >= 1) thresholds[0]++;
      if (max >= 2) thresholds[1]++;
      if (max >= 4) thresholds[2]++;
      if (max >= 8) thresholds[3]++;
    }
    if (end < count) await yieldControl();
  }
  signal.throwIfAborted();
  const means = signed.map(value => value / count), errors = absolute.map(value => value / count);
  return {
    meanDeltaR: means[0], meanDeltaG: means[1], meanDeltaB: means[2],
    meanAbsoluteDeltaR: errors[0], meanAbsoluteDeltaG: errors[1], meanAbsoluteDeltaB: errors[2],
    maxAbsoluteDeltaR: maxima[0], maxAbsoluteDeltaG: maxima[1], maxAbsoluteDeltaB: maxima[2],
    meanAbsoluteError: (absolute[0] + absolute[1] + absolute[2]) / (count * 3), rmse: Math.sqrt(squared / (count * 3)),
    exactMatchPixelPercent: exact / count * 100,
    pixelsAtLeast1Percent: thresholds[0] / count * 100, pixelsAtLeast2Percent: thresholds[1] / count * 100,
    pixelsAtLeast4Percent: thresholds[2] / count * 100, pixelsAtLeast8Percent: thresholds[3] / count * 100,
    // Luma is the same weighted sRGB-byte proxy on both sides, not linear-light photometry.
    meanLumaDelta: 0.2126 * means[0] + 0.7152 * means[1] + 0.0722 * means[2],
    // Positive means G increased relative to the R/B average; this is not a Delta E metric.
    greenBias: means[1] - (means[0] + means[2]) / 2,
  };
}

export async function runDecodeComparison(assetId: string, signal: AbortSignal, phase: (value: DecodePhase) => void,
  dependencies: Partial<DecodeComparisonDependencies> = {}): Promise<DecodeComparisonReport> {
  const deps = { decode: decodeEditSource, backend: fetchBackendDecode, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), yield: yieldToUi, ...dependencies };
  const report = emptyDecodeComparison(); report.status = 'running';
  const started = performance.now();
  let source: ImageData | null = null, backend: BackendDecodedImage | null = null, objectUrl: string | null = null;
  let code: DecodeComparisonErrorCode = 'original_fetch_failed';
  const releaseUrl = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  signal.addEventListener('abort', releaseUrl, { once: true });
  const stage = (value: DecodePhase, failureCode: DecodeComparisonErrorCode) => { signal.throwIfAborted(); code = failureCode; phase(value); };
  try {
    if (!assetId) throw new DecodeComparisonError('no_asset_selected');
    stage('original', 'original_fetch_failed');
    const response = await deps.fetch(`/api/assets/${encodeURIComponent(assetId)}/original`, { signal, cache: 'no-store' });
    signal.throwIfAborted(); if (!response.ok) throw new DecodeComparisonError(code);
    let blob: Blob | null = await response.blob(); signal.throwIfAborted();
    objectUrl = URL.createObjectURL(blob); blob = null;
    stage('frontend', 'frontend_decode_failed');
    let timer = performance.now();
    try { source = await deps.decode({ kind: 'jpeg-original', url: objectUrl }, signal); signal.throwIfAborted(); }
    finally { report.timing.frontendDecodeMs = performance.now() - timer; releaseUrl(); }
    report.dimensions.frontend = { width: source.width, height: source.height };
    stage('backend', 'backend_unavailable');
    timer = performance.now();
    try { backend = await deps.backend(assetId, signal); signal.throwIfAborted(); }
    finally { report.timing.backendRequestMs = performance.now() - timer; }
    report.timing.backendDecodeMs = backend.metadata.backendDecodeMs;
    report.sourceIcc = backend.metadata.sourceIcc; report.orientationNormalized = backend.metadata.orientationNormalized;
    report.dimensions.backend = { width: backend.metadata.width, height: backend.metadata.height };
    stage('comparison', 'invalid_binary_response');
    timer = performance.now();
    try { await deps.yield(); signal.throwIfAborted(); report.statistics = await compareDecodedPixels(source, backend, signal, deps.yield); }
    finally { report.timing.comparisonMs = performance.now() - timer; }
    report.assessment = assessDecodeDifference(report.statistics); report.status = 'completed';
  } catch (failure) {
    report.status = signal.aborted ? 'cancelled' : 'failed';
    report.error = signal.aborted ? 'cancelled' : failure instanceof DecodeComparisonError ? failure.code : code;
  } finally {
    source = null; backend = null; releaseUrl(); signal.removeEventListener('abort', releaseUrl);
    report.timing.totalMs = performance.now() - started;
  }
  return report;
}
