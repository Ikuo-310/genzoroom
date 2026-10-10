import { downloadDiagnosticJson } from './diagnosticExport';
import type { AdapterInfo, DiagnosticValue, SmokeCode, SmokeState } from './webgpuSmoke';
import { createJpegReport, emptyJpegReport, type JpegReport } from './jpegDiagnosticsReport';

export interface DiagnosticsEnvironment {
  secureContext: boolean | null;
  crossOriginIsolated: boolean | null;
  gpuApiAvailable: boolean;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  devicePixelRatio: number | null;
  viewport: { width: number | null; height: number | null };
  userAgent: string | null;
  platform: string | null;
}

// WebIDL limits may live on the prototype; explicit keys also prevent unrelated data export.
export const GPU_LIMIT_NAMES = [
  'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers',
  'maxBindGroups', 'maxBindGroupsPlusVertexBuffers', 'maxBindingsPerBindGroup',
  'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
  'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxUniformBufferBindingSize',
  'maxStorageBufferBindingSize', 'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
  'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes', 'maxVertexBufferArrayStride',
  'maxInterStageShaderVariables', 'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension',
] as const;
export interface GpuCapabilities {
  features: string[] | null;
  limits: Partial<Record<typeof GPU_LIMIT_NAMES[number], number>> | null;
}
export interface SmokeTimings {
  totalMs: number | null;
  adapterRequestMs: number | null;
  deviceRequestMs: number | null;
  initializationMs: number | null;
  sourceUploadMs: number | null;
}
export const emptySmokeTimings = (): SmokeTimings => ({
  totalMs: null, adapterRequestMs: null, deviceRequestMs: null, initializationMs: null, sourceUploadMs: null,
});

function read<T>(get: () => unknown, accepts: (value: unknown) => value is T): T | null {
  try { const value = get(); return accepts(value) ? value : null; } catch { return null; }
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';

export function collectDiagnosticsEnvironment(browser: Window = window, agent: Navigator = navigator): DiagnosticsEnvironment {
  // Only these passive properties are read; do not enumerate browser objects or storage.
  return {
    secureContext: read(() => browser.isSecureContext, boolean),
    crossOriginIsolated: read(() => browser.crossOriginIsolated, boolean),
    gpuApiAvailable: read(() => Boolean((agent as Navigator & { gpu?: unknown }).gpu), boolean) ?? false,
    hardwareConcurrency: read(() => agent.hardwareConcurrency, number),
    deviceMemory: read(() => (agent as Navigator & { deviceMemory?: number }).deviceMemory, number),
    devicePixelRatio: read(() => browser.devicePixelRatio, number),
    viewport: { width: read(() => browser.innerWidth, number), height: read(() => browser.innerHeight, number) },
    userAgent: read(() => agent.userAgent, string),
    platform: read(() => agent.platform, string),
  };
}

export function captureGpuCapabilities(source: object): GpuCapabilities {
  const gpu = source as { features?: Iterable<string>; limits?: Record<string, unknown> };
  let features: string[] | null = null;
  try { if (gpu.features) features = Array.from(gpu.features).filter(string).sort(); } catch { /* Optional capability data must not stop the smoke run. */ }
  const limits: GpuCapabilities['limits'] = {};
  for (const key of GPU_LIMIT_NAMES) {
    const value = read(() => gpu.limits?.[key], number);
    if (value !== null) limits[key] = value;
  }
  return { features, limits: Object.keys(limits).length ? limits : null };
}

export function captureAdapterInfo(info: AdapterInfo): AdapterInfo {
  const result: AdapterInfo = {};
  for (const key of ['vendor', 'architecture', 'device', 'description'] as const) {
    const value = read(() => info[key], string);
    if (value !== null) result[key] = value;
  }
  return result;
}

const STATUS_CODES = {
  notAcquired: 'not_acquired', notChecked: 'not_checked', idle: 'not_run', running: 'running',
  success: 'success', failed: 'failed', noAdapter: 'no_adapter', noInfo: 'info_unavailable',
  infoFailed: 'info_failed', shaderFailed: 'shader_failed', shaderSuccess: 'success',
  insecure: 'insecure_context', noGpu: 'gpu_unavailable', cancelled: 'cancelled',
  initializationFailed: 'initialization_failed', complete: 'completed', partialFailure: 'completed_with_errors',
  generationMismatch: 'generation_mismatch',
} as const satisfies Record<SmokeCode, string>;
type ReportCode = typeof STATUS_CODES[SmokeCode];
interface ReportDiagnostic { status: ReportCode; detail: string | null }
interface ReportError { code: ReportCode | 'case_failed'; detail: string | null }
export interface WebGpuReport {
  apiAvailable: boolean;
  smoke: {
    status: 'not_run' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
    error: ReportError | null;
    adapter: ReportDiagnostic;
    device: ReportDiagnostic;
    shader: ReportDiagnostic;
    adapterInfo: ReportDiagnostic & { data: Record<keyof AdapterInfo, string | null> | null };
    adapterCapabilities: GpuCapabilities | null;
    deviceCapabilities: GpuCapabilities | null;
    timing: SmokeTimings;
    cases: Array<{
      name: string;
      status: 'success' | 'failed';
      error: ReportError | null;
      comparison: { maximumDifference: number; differingChannels: number; alphaMatches: boolean } | null;
      timing: { cpuMs: number | null; gpuMs: number | null };
    }>;
  };
}
export interface DiagnosticsReport {
  schemaVersion: 1;
  generatedAt: string;
  environment: DiagnosticsEnvironment;
  webgpu: WebGpuReport;
  jpeg: JpegReport;
}
export interface JpegDiagnosticsReport { schemaVersion: 1; generatedAt: string; environment: DiagnosticsEnvironment; jpeg: JpegReport }
export interface WebGpuDiagnosticsReport { schemaVersion: 1; generatedAt: string; environment: DiagnosticsEnvironment; webgpu: WebGpuReport }
const diagnostic = (value?: DiagnosticValue): ReportDiagnostic => ({
  status: value ? STATUS_CODES[value.code] : 'not_acquired', detail: value?.detail ?? null,
});
const capabilities = (value: GpuCapabilities | null | undefined): GpuCapabilities | null => value ? {
  features: value.features ? [...value.features] : null,
  limits: value.limits ? Object.fromEntries(GPU_LIMIT_NAMES.flatMap(key =>
    value.limits?.[key] === undefined ? [] : [[key, value.limits[key]]])) : null,
} : null;

export function createWebGpuReport(apiAvailable: boolean, state: SmokeState | null): WebGpuReport {
  const code = state?.status.code ?? 'idle';
  const status = code === 'idle' ? 'not_run' : code === 'running' ? 'running' : code === 'complete' ? 'completed'
    : code === 'partialFailure' ? 'completed_with_errors' : code === 'cancelled' ? 'cancelled' : 'failed';
  const info = state?.info.data ? captureAdapterInfo(state.info.data) : null;
  // An explicit export projection keeps Recipe, pixels, renderer objects and UI state out of the schema.
  return {
    apiAvailable,
    smoke: {
      status, error: status === 'failed' || status === 'cancelled' ? { code: STATUS_CODES[code], detail: state?.status.detail ?? null } : null,
      adapter: diagnostic(state?.adapter), device: diagnostic(state?.device),
      shader: state ? diagnostic(state.shader) : { status: 'not_checked', detail: null },
      adapterInfo: { ...diagnostic(state?.info), data: info ? {
        vendor: info.vendor ?? null, architecture: info.architecture ?? null, device: info.device ?? null, description: info.description ?? null,
      } : null },
      adapterCapabilities: capabilities(state?.adapterCapabilities), deviceCapabilities: capabilities(state?.deviceCapabilities),
      timing: state ? {
        totalMs: state.timing.totalMs, adapterRequestMs: state.timing.adapterRequestMs,
        deviceRequestMs: state.timing.deviceRequestMs, initializationMs: state.timing.initializationMs, sourceUploadMs: state.timing.sourceUploadMs,
      } : emptySmokeTimings(),
      cases: state?.results.map(result => ({
        name: result.name, status: result.success ? 'success' : 'failed',
        error: result.success ? null : { code: result.errorCode ? STATUS_CODES[result.errorCode] : 'case_failed', detail: result.error ?? null },
        comparison: result.comparison ? {
          maximumDifference: result.comparison.maximumDifference, differingChannels: result.comparison.differingChannels,
          alphaMatches: result.comparison.alphaMatches,
        } : null,
        timing: { cpuMs: result.cpuMs ?? null, gpuMs: result.gpuMs ?? null },
      })) ?? [],
    },
  };
}

export function createDiagnosticsReport(environment: DiagnosticsEnvironment, webgpu: WebGpuReport,
  date = new Date(), jpeg: JpegReport = emptyJpegReport()): DiagnosticsReport {
  // Copy the data snapshot so a run continuing after export cannot alter this report.
  return JSON.parse(JSON.stringify({ schemaVersion: 1, generatedAt: date.toISOString(), environment, webgpu, jpeg: createJpegReport(jpeg) })) as DiagnosticsReport;
}

export function createJpegDiagnosticsReport(environment: DiagnosticsEnvironment, jpeg: JpegReport, date = new Date()): JpegDiagnosticsReport {
  return JSON.parse(JSON.stringify({ schemaVersion: 1, generatedAt: date.toISOString(), environment, jpeg: createJpegReport(jpeg) })) as JpegDiagnosticsReport;
}

export function createWebGpuDiagnosticsReport(environment: DiagnosticsEnvironment, webgpu: WebGpuReport, date = new Date()): WebGpuDiagnosticsReport {
  return JSON.parse(JSON.stringify({ schemaVersion: 1, generatedAt: date.toISOString(), environment, webgpu })) as WebGpuDiagnosticsReport;
}

export function exportDiagnosticsReport(report: DiagnosticsReport): Promise<void> { return downloadDiagnosticJson(report, 'genzoroom-diagnostics'); }
export function exportJpegDiagnosticsReport(report: JpegDiagnosticsReport): Promise<void> { return downloadDiagnosticJson(report, 'genzoroom-jpeg-diagnostics'); }
export function exportWebGpuDiagnosticsReport(report: WebGpuDiagnosticsReport): Promise<void> { return downloadDiagnosticJson(report, 'genzoroom-webgpu-diagnostics'); }
