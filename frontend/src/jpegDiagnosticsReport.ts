import type { AdjustmentId } from './editing';

export type JpegCaseId = AdjustmentId | 'all_sliders_representative';
export type JpegSelectionMode = 'automatic' | 'manual';
export type JpegErrorCode = 'asset_lookup_failed' | 'original_fetch_failed' | 'profile_failed' | 'decode_failed'
  | 'source_histogram_failed' | 'cpu_render_failed' | 'cpu_histogram_failed' | 'gpu_unavailable'
  | 'gpu_initialization_failed' | 'gpu_upload_failed' | 'gpu_render_failed' | 'gpu_histogram_failed';
export interface JpegError { code: JpegErrorCode; detail: null }
export interface JpegCaseResult {
  id: JpegCaseId;
  status: 'completed' | 'completed_with_errors' | 'failed';
  cpuStatus: 'completed' | 'failed';
  gpuStatus: 'completed' | 'failed' | 'unavailable' | 'skipped';
  cpuRenderMs: number | null;
  cpuHistogramMs: number | null;
  gpuRenderMs: number | null;
  gpuHistogramMs: number | null;
  cpuError: JpegError | null;
  gpuError: JpegError | null;
}
export interface JpegTiming {
  totalMs: number | null;
  assetLookupMs: number | null;
  originalFetchMs: number | null;
  profileReadMs: number | null;
  decodeToSrgbImageDataMs: number | null;
  sourceHistogramMs: number | null;
  gpuInitializationMs: number | null;
  gpuSourceUploadMs: number | null;
}
export interface JpegReport {
  status: 'not_run' | 'running' | 'completed' | 'completed_with_errors' | 'cancelled' | 'no_jpeg_candidate' | 'failed';
  selectionMode: JpegSelectionMode;
  error: JpegError | null;
  source: {
    compressedBytes: number | null;
    width: number | null;
    height: number | null;
    profile: { status: 'not_read' | 'embedded' | 'none' | 'unknown'; description: string | null };
  };
  gpu: { status: 'not_run' | 'ready' | 'completed' | 'unavailable' | 'failed'; error: JpegError | null };
  timing: JpegTiming;
  cases: JpegCaseResult[];
}
export function emptyJpegReport(selectionMode: JpegSelectionMode = 'automatic'): JpegReport {
  return {
    status: 'not_run', selectionMode, error: null,
    source: { compressedBytes: null, width: null, height: null, profile: { status: 'not_read', description: null } },
    gpu: { status: 'not_run', error: null },
    timing: { totalMs: null, assetLookupMs: null, originalFetchMs: null, profileReadMs: null,
      decodeToSrgbImageDataMs: null, sourceHistogramMs: null, gpuInitializationMs: null, gpuSourceUploadMs: null },
    cases: [],
  };
}
const error = (value: JpegError | null): JpegError | null => value ? { code: value.code, detail: null } : null;
export function createJpegReport(value: JpegReport): JpegReport {
  // Never spread run state: it may contain private selection data or large pixel buffers in future.
  return {
    status: value.status, selectionMode: value.selectionMode, error: error(value.error),
    source: { compressedBytes: value.source.compressedBytes, width: value.source.width, height: value.source.height,
      profile: { status: value.source.profile.status, description: value.source.profile.description } },
    gpu: { status: value.gpu.status, error: error(value.gpu.error) },
    timing: { totalMs: value.timing.totalMs, assetLookupMs: value.timing.assetLookupMs,
      originalFetchMs: value.timing.originalFetchMs, profileReadMs: value.timing.profileReadMs,
      decodeToSrgbImageDataMs: value.timing.decodeToSrgbImageDataMs, sourceHistogramMs: value.timing.sourceHistogramMs,
      gpuInitializationMs: value.timing.gpuInitializationMs, gpuSourceUploadMs: value.timing.gpuSourceUploadMs },
    cases: value.cases.map(row => ({
      id: row.id, status: row.status, cpuStatus: row.cpuStatus, gpuStatus: row.gpuStatus,
      cpuRenderMs: row.cpuRenderMs, cpuHistogramMs: row.cpuHistogramMs,
      gpuRenderMs: row.gpuRenderMs, gpuHistogramMs: row.gpuHistogramMs,
      cpuError: error(row.cpuError), gpuError: error(row.gpuError),
    })),
  };
}
