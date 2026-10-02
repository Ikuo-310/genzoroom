import { renderAdjustments } from './adjustmentPipeline';
import { gpuRecipeCases, gpuComparisonPixels } from './webgpuRecipeCases';
import { compareRgba } from './webgpuComparison';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import type { ExposureGpu, ExposureGpuDevice } from './webgpuTypes';
import { captureAdapterInfo, captureGpuCapabilities, emptySmokeTimings, type GpuCapabilities, type SmokeTimings } from './developerDiagnostics';

export interface AdapterInfo { vendor?: string; architecture?: string; device?: string; description?: string }
interface SmokeGpu extends ExposureGpu {
  requestAdapter(): Promise<{
    requestDevice(): Promise<ExposureGpuDevice>;
    readonly info?: AdapterInfo;
    requestAdapterInfo?(): Promise<AdapterInfo>;
    readonly features?: Iterable<string>;
    readonly limits?: object;
  } | null>;
}
export interface SmokeEnvironment { secureContext: boolean; gpu?: SmokeGpu }
type Renderer = Pick<WebGpuAdjustmentRenderer, 'setSource' | 'render' | 'dispose'>;
export type SmokeFactory = (gpu: ExposureGpu, onError: (error: unknown) => void) => Promise<Renderer | null>;
export const SMOKE_CASES = gpuRecipeCases();

export const smokePixels = gpuComparisonPixels;

interface SmokeResult {
  name: string;
  success: boolean;
  comparison?: ReturnType<typeof compareRgba>;
  error?: string;
  errorCode?: SmokeCode;
  cpuMs?: number | null;
  gpuMs?: number | null;
}
export type SmokeCode = 'notAcquired' | 'notChecked' | 'idle' | 'running' | 'success' | 'failed' | 'noAdapter' | 'noInfo' | 'infoFailed' | 'shaderFailed' | 'shaderSuccess' | 'insecure' | 'noGpu' | 'cancelled' | 'initializationFailed' | 'complete' | 'partialFailure' | 'generationMismatch';
export interface DiagnosticValue { code: SmokeCode; detail?: string }
export interface SmokeState {
  running: boolean;
  adapter: DiagnosticValue;
  device: DiagnosticValue;
  shader: DiagnosticValue;
  info: DiagnosticValue & { data?: AdapterInfo };
  status: DiagnosticValue;
  results: SmokeResult[];
  adapterCapabilities: GpuCapabilities | null;
  deviceCapabilities: GpuCapabilities | null;
  timing: SmokeTimings;
}
class SmokeError extends Error {
  constructor(readonly code: SmokeCode) { super(code); }
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** One run owns its renderer, including devices that arrive after page departure. */
export class WebGpuSmoke {
  private renderer: Renderer | null = null;
  private initializingDevice: ExposureGpuDevice | null = null;
  private closed = false;
  readonly state: SmokeState = {
    running: false, adapter: { code: 'notAcquired' }, device: { code: 'notAcquired' }, shader: { code: 'notChecked' }, info: { code: 'notAcquired' },
    status: { code: 'idle' }, results: [], adapterCapabilities: null, deviceCapabilities: null, timing: emptySmokeTimings(),
  };

  constructor(private environment: SmokeEnvironment, private update: (state: SmokeState) => void,
    private factory: SmokeFactory = WebGpuAdjustmentRenderer.create) {}

  dispose() {
    this.closed = true;
    this.renderer?.dispose();
    // create() has not returned its owner yet; destroy interrupts pending shader compilation.
    this.initializingDevice?.destroy();
    this.initializingDevice = null;
  }

  async run(): Promise<void> {
    if (this.closed || this.state.running) return;
    const started = performance.now();
    Object.assign(this.state, { running: true, adapter: { code: 'notAcquired' }, device: { code: 'notAcquired' }, shader: { code: 'notChecked' },
      info: { code: 'notAcquired' }, status: { code: 'running' }, results: [],
      adapterCapabilities: null, deviceCapabilities: null, timing: emptySmokeTimings() });
    const publish = () => { if (!this.closed) this.update(this.state); };
    publish();
    let initializationError = '';
    let initializationCode: SmokeCode | undefined;
    try {
      if (!this.environment.secureContext) throw new SmokeError('insecure');
      const gpu = this.environment.gpu;
      if (!gpu) throw new SmokeError('noGpu');
      const diagnosticGpu: ExposureGpu = {
        requestAdapter: async () => {
          let adapter: Awaited<ReturnType<SmokeGpu['requestAdapter']>>;
          const adapterStarted = performance.now();
          try {
            try { adapter = await gpu.requestAdapter(); }
            finally { this.state.timing.adapterRequestMs = performance.now() - adapterStarted; }
            this.state.adapter = { code: adapter ? 'success' : 'noAdapter' };
          } catch (error) {
            this.state.adapter = { code: 'failed', detail: errorText(error) };
            throw error;
          }
          publish();
          if (this.closed) throw new SmokeError('cancelled');
          if (!adapter) throw new SmokeError('noAdapter');
          this.state.adapterCapabilities = captureGpuCapabilities(adapter);
          try {
            const info = adapter.info ?? await adapter.requestAdapterInfo?.();
            this.state.info = info ? { code: 'success', data: captureAdapterInfo(info) } : { code: 'noInfo' };
          } catch (error) { this.state.info = { code: 'infoFailed', detail: errorText(error) }; }
          publish();
          return {
            requestDevice: async () => {
              if (this.closed) throw new SmokeError('cancelled');
              const deviceStarted = performance.now();
              try {
                let device: ExposureGpuDevice;
                try { device = await adapter.requestDevice(); }
                finally { this.state.timing.deviceRequestMs = performance.now() - deviceStarted; }
                if (this.closed) { device.destroy(); throw new SmokeError('cancelled'); }
                this.initializingDevice = device;
                this.state.deviceCapabilities = captureGpuCapabilities(device);
                this.state.device = { code: 'success' };
                return device;
              } catch (error) {
                this.state.device = { code: 'failed', detail: errorText(error) };
                throw error;
              } finally { publish(); }
            },
          };
        },
      };
      // Initialization includes adapter/device requests and optional info; these timings overlap.
      const initializationStarted = performance.now();
      try {
        this.renderer = await this.factory(diagnosticGpu, error => {
          initializationError = error instanceof SmokeError ? '' : errorText(error);
          initializationCode = error instanceof SmokeError ? error.code : undefined;
        });
      } finally { this.state.timing.initializationMs = performance.now() - initializationStarted; }
      if (this.renderer) this.initializingDevice = null;
      if (this.closed) return;
      if (!this.renderer) {
        if (this.state.device.code === 'success') this.state.shader = { code: 'shaderFailed', detail: initializationError || undefined };
        throw initializationCode ? new SmokeError(initializationCode) : initializationError ? new Error(initializationError) : new SmokeError('initializationFailed');
      }
      this.state.shader = { code: 'shaderSuccess' };
      publish();
      const source = smokePixels();
      const uploadStarted = performance.now();
      let generation: number;
      try { generation = await this.renderer.setSource(source, 32, 16); }
      finally { this.state.timing.sourceUploadMs = performance.now() - uploadStarted; }
      for (const { name, recipe } of SMOKE_CASES) {
        if (this.closed) return;
        let cpuMs: number | null = null;
        let gpuMs: number | null = null;
        try {
          const cpuStarted = performance.now();
          let cpu: Uint8ClampedArray;
          try { cpu = renderAdjustments(source, recipe); }
          finally { cpuMs = performance.now() - cpuStarted; }
          const gpuStarted = performance.now();
          let result: Awaited<ReturnType<Renderer['render']>>;
          try { result = await this.renderer.render(recipe); }
          finally { gpuMs = performance.now() - gpuStarted; }
          if (result.sourceGeneration !== generation) throw new SmokeError('generationMismatch');
          if (this.closed) return;
          this.state.results.push({ name, success: true, comparison: compareRgba(cpu, result.pixels), cpuMs, gpuMs });
        } catch (error) {
          if (this.closed) return;
          this.state.results.push({ name, success: false, error: error instanceof SmokeError ? undefined : errorText(error), errorCode: error instanceof SmokeError ? error.code : undefined, cpuMs, gpuMs });
        }
        publish();
      }
      this.state.status = { code: this.state.results.every(result => result.success) ? 'complete' : 'partialFailure' };
    } catch (error) {
      this.state.status = { code: error instanceof SmokeError ? error.code : 'failed', detail: error instanceof SmokeError ? undefined : errorText(error) };
      this.state.results = SMOKE_CASES.map(({ name }) => ({ name, success: false, error: error instanceof SmokeError ? undefined : errorText(error), errorCode: error instanceof SmokeError ? error.code : undefined }));
    } finally {
      this.renderer?.dispose();
      this.renderer = null;
      this.initializingDevice?.destroy();
      this.initializingDevice = null;
      this.state.timing.totalMs = performance.now() - started;
      this.state.running = false;
      publish();
    }
  }
}
