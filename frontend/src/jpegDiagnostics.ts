import { fetchRecentAssets } from './api';
import type { RecentAsset } from './assets';
import { defaultRecipe, ADJUSTMENT_IDS, type EditRecipe } from './editing';
import { decodeEditSource } from './editImageSource';
import { readJpegProfile } from './jpegProfile';
import { renderAdjustments } from './adjustmentPipeline';
import { collectHistogram } from './histogram';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import { createJpegReport, emptyJpegReport, type JpegCaseId, type JpegCaseResult, type JpegErrorCode, type JpegReport, type JpegTiming } from './jpegDiagnosticsReport';

export const JPEG_CASES: Array<{ id: JpegCaseId; recipe: EditRecipe }> = [
  ...ADJUSTMENT_IDS.map(id => {
    const recipe = defaultRecipe(); recipe.adjustments[id] = id === 'exposure' ? 0.5 : 35;
    return { id, recipe };
  }),
  { id: 'all_sliders_representative', recipe: (() => {
    const recipe = defaultRecipe();
    for (const id of ADJUSTMENT_IDS) recipe.adjustments[id] = id === 'exposure' ? 0.5 : 35;
    return recipe;
  })() },
];
export function recentJpegCandidates(assets: RecentAsset[]): RecentAsset[] {
  // The Recent API orders newest first; keep that order and restrict inspection to the requested window.
  return assets.slice(0, 50).filter(asset => asset.format === 'JPEG' && asset.is_raw === false).slice(0, 10);
}
type Renderer = Pick<WebGpuAdjustmentRenderer, 'setSource' | 'render' | 'dispose'>;
export interface JpegDiagnosticsDependencies {
  recent: typeof fetchRecentAssets;
  fetch: typeof fetch;
  profile: typeof readJpegProfile;
  decode: typeof decodeEditSource;
  cpu: typeof renderAdjustments;
  histogram: typeof collectHistogram;
  gpuAvailable: () => boolean;
  createRenderer: (onError: (error: unknown) => void, signal: AbortSignal) => Promise<Renderer | null>;
  yield: () => Promise<void>;
}
const defaults: JpegDiagnosticsDependencies = {
  recent: fetchRecentAssets, fetch: (...args) => fetch(...args), profile: readJpegProfile, decode: decodeEditSource,
  cpu: renderAdjustments, histogram: collectHistogram,
  gpuAvailable: () => window.isSecureContext && Boolean((navigator as Navigator & { gpu?: unknown }).gpu),
  createRenderer: (onError, signal) => WebGpuAdjustmentRenderer.create(undefined, onError, signal),
  // Let UI progress and navigation/abort events run between large CPU cases; this is outside case timings.
  yield: () => new Promise(resolve => window.setTimeout(resolve, 0)),
};
export type JpegPhase = 'idle' | 'asset_lookup' | 'original_fetch' | 'profile_read' | 'decode'
  | 'source_histogram' | 'gpu_initialization' | 'gpu_upload' | 'cases';
export interface JpegRunState { running: boolean; phase: JpegPhase; currentCase: JpegCaseId | null; report: JpegReport }
class JpegDiagnosticError extends Error {
  constructor(readonly code: JpegErrorCode) { super(code); }
}
const error = (code: JpegErrorCode) => ({ code, detail: null });

export class RealJpegRunner {
  private closed = false;
  private controller: AbortController | null = null;
  private renderer: Renderer | null = null;
  private objectUrl: string | null = null;
  private readonly dependencies: JpegDiagnosticsDependencies;
  readonly state: JpegRunState = { running: false, phase: 'idle', currentCase: null, report: emptyJpegReport() };
  constructor(private update: (value: JpegRunState) => void, dependencies: Partial<JpegDiagnosticsDependencies> = {},
    private onTarget?: (asset: RecentAsset) => void) {
    this.dependencies = { ...defaults, ...dependencies };
  }
  private release() {
    this.renderer?.dispose(); this.renderer = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
  dispose() { this.closed = true; this.controller?.abort(); this.release(); }
  private publish() {
    if (!this.closed) this.update({ ...this.state, report: createJpegReport(this.state.report) });
  }
  async run(manual: RecentAsset | null = null): Promise<void> {
    if (this.closed || this.state.running) return;
    this.release();
    const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const report = emptyJpegReport(manual ? 'manual' : 'automatic');
    Object.assign(this.state, { running: true, phase: 'idle', currentCase: null, report });
    report.status = 'running';
    const started = performance.now(); this.publish();
    const dependencies = this.dependencies;
    let source: ImageData | null = null;
    const stage = (phase: JpegPhase) => { this.state.phase = phase; this.publish(); signal.throwIfAborted(); };
    const measure = async <T>(key: keyof JpegTiming, code: JpegErrorCode, action: () => Promise<T> | T): Promise<T> => {
      const start = performance.now();
      try { const value = await action(); signal.throwIfAborted(); return value; }
      catch { signal.throwIfAborted(); throw new JpegDiagnosticError(code); }
      finally { report.timing[key] = performance.now() - start; }
    };
    try {
      let asset = manual;
      if (!asset) {
        stage('asset_lookup');
        asset = await measure('assetLookupMs', 'asset_lookup_failed', async () =>
          recentJpegCandidates(await dependencies.recent(50, signal))[0] ?? null);
      }
      if (!asset) { report.status = 'no_jpeg_candidate'; return; }
      // This callback is UI-only; filenames and request identity never enter diagnostic state.
      this.onTarget?.(asset);
      stage('original_fetch');
      let blob: Blob | null = await measure('originalFetchMs', 'original_fetch_failed', async () => {
        const response = await dependencies.fetch(`/api/assets/${encodeURIComponent(asset!.id)}/original`, { signal, cache: 'no-store' });
        signal.throwIfAborted();
        if (!response.ok) throw new JpegDiagnosticError('original_fetch_failed');
        return response.blob();
      });
      asset = null; // Only requests use the private identity; the report never owns an Asset.
      report.source.compressedBytes = blob.size;
      stage('profile_read');
      const profile = await measure('profileReadMs', 'profile_failed', () => dependencies.profile(blob!, signal));
      report.source.profile = { status: profile.status, description: profile.status === 'embedded' ? profile.description : null };
      this.objectUrl = URL.createObjectURL(blob);
      blob = null;
      stage('decode');
      try {
        source = await measure('decodeToSrgbImageDataMs', 'decode_failed', () =>
          dependencies.decode({ kind: 'jpeg-original', url: this.objectUrl! }, signal));
      } finally {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      report.source.width = source.width; report.source.height = source.height;
      stage('source_histogram');
      await measure('sourceHistogramMs', 'source_histogram_failed', () => { dependencies.histogram(source!.data); });
      stage('gpu_initialization');
      if (!dependencies.gpuAvailable()) report.gpu = { status: 'unavailable', error: error('gpu_unavailable') };
      else {
        let initializationFailed = false;
        try {
          const renderer = await measure('gpuInitializationMs', 'gpu_initialization_failed', () =>
            dependencies.createRenderer(() => { initializationFailed = true; }, signal).then(value => {
              // A factory can finish after departure; it must not lose its late resource owner.
              if (signal.aborted) { value?.dispose(); signal.throwIfAborted(); }
              return value;
            }));
          this.renderer = renderer;
          report.gpu = renderer ? { status: 'ready', error: null }
            : { status: initializationFailed ? 'failed' : 'unavailable', error: error(initializationFailed ? 'gpu_initialization_failed' : 'gpu_unavailable') };
        } catch { signal.throwIfAborted(); report.gpu = { status: 'failed', error: error('gpu_initialization_failed') }; }
      }
      let generation: number | null = null;
      if (this.renderer) {
        stage('gpu_upload');
        try { generation = await measure('gpuSourceUploadMs', 'gpu_upload_failed', () => this.renderer!.setSource(source!.data, source!.width, source!.height)); }
        catch { signal.throwIfAborted(); report.gpu = { status: 'failed', error: error('gpu_upload_failed') }; this.renderer?.dispose(); this.renderer = null; }
      }
      stage('cases');
      for (const { id, recipe } of JPEG_CASES) {
        signal.throwIfAborted(); this.state.currentCase = id; this.publish();
        const row: JpegCaseResult = { id, status: 'completed', cpuStatus: 'completed', gpuStatus: 'skipped',
          cpuRenderMs: null, cpuHistogramMs: null, gpuRenderMs: null, gpuHistogramMs: null, cpuError: null, gpuError: null };
        this.cpuCase(source, recipe, row);
        signal.throwIfAborted();
        if (this.renderer) {
          await this.gpuCase(recipe, generation!, row, signal);
          signal.throwIfAborted();
          if (row.gpuStatus === 'failed') {
            report.gpu = { status: 'failed', error: row.gpuError };
            this.renderer?.dispose(); this.renderer = null;
          }
        } else {
          row.gpuStatus = report.gpu.status === 'unavailable' ? 'unavailable' : 'skipped'; row.gpuError = report.gpu.error;
        }
        row.status = row.cpuStatus === 'failed' ? 'failed' : row.gpuStatus === 'completed' ? 'completed' : 'completed_with_errors';
        report.cases.push(row); this.publish();
        await dependencies.yield();
      }
      signal.throwIfAborted();
      if (report.gpu.status === 'ready') report.gpu.status = 'completed';
      report.status = report.cases.every(row => row.status === 'completed') ? 'completed' : 'completed_with_errors';
    } catch (failure) {
      report.status = signal.aborted ? 'cancelled' : 'failed';
      // JPEG dependency errors may contain private request URLs or IDs; publish codes only.
      report.error = signal.aborted ? null : error(failure instanceof JpegDiagnosticError ? failure.code : 'decode_failed');
    } finally {
      this.release(); source = null;
      report.timing.totalMs = performance.now() - started;
      this.state.running = false; this.state.phase = 'idle'; this.state.currentCase = null;
      this.controller = null; this.publish();
    }
  }
  private cpuCase(source: ImageData, recipe: EditRecipe, row: JpegCaseResult) {
    let stage: JpegErrorCode = 'cpu_render_failed';
    try {
      let output: Uint8ClampedArray;
      const start = performance.now();
      try { output = this.dependencies.cpu(source.data, recipe); }
      finally { row.cpuRenderMs = performance.now() - start; }
      stage = 'cpu_histogram_failed';
      const histogramStart = performance.now();
      try { this.dependencies.histogram(output); }
      finally { row.cpuHistogramMs = performance.now() - histogramStart; }
    } catch { row.cpuStatus = 'failed'; row.cpuError = error(stage); }
    // The CPU output is scoped to this call and cannot survive into GPU work or the next case.
  }
  private async gpuCase(recipe: EditRecipe, generation: number, row: JpegCaseResult, signal: AbortSignal) {
    let stage: JpegErrorCode = 'gpu_render_failed';
    try {
      const start = performance.now();
      let result: Awaited<ReturnType<Renderer['render']>>;
      try { result = await this.renderer!.render(recipe); }
      finally { row.gpuRenderMs = performance.now() - start; }
      signal.throwIfAborted();
      if (result.sourceGeneration !== generation) throw new JpegDiagnosticError(stage);
      stage = 'gpu_histogram_failed';
      const histogramStart = performance.now();
      try { this.dependencies.histogram(result.pixels); }
      finally { row.gpuHistogramMs = performance.now() - histogramStart; }
      row.gpuStatus = 'completed';
    } catch { signal.throwIfAborted(); row.gpuStatus = 'failed'; row.gpuError = error(stage); }
  }
}
