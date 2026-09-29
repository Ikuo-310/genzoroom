import { renderAdjustments } from './adjustmentPipeline';
import { gpuRecipeCases, gpuComparisonPixels } from './webgpuRecipeCases';
import { compareRgba } from './webgpuComparison';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import i18n from './i18n';
import type { ExposureGpu, ExposureGpuDevice } from './webgpuTypes';

interface AdapterInfo { vendor?: string; architecture?: string; device?: string; description?: string }
interface SmokeGpu extends ExposureGpu {
  requestAdapter(): Promise<{
    requestDevice(): Promise<ExposureGpuDevice>;
    readonly info?: AdapterInfo;
    requestAdapterInfo?(): Promise<AdapterInfo>;
  } | null>;
}
export interface SmokeEnvironment { secureContext: boolean; gpu?: SmokeGpu }
type Renderer = Pick<WebGpuAdjustmentRenderer, 'setSource' | 'render' | 'dispose'>;
type Factory = (gpu: ExposureGpu, onError: (error: unknown) => void) => Promise<Renderer | null>;
export const SMOKE_CASES = gpuRecipeCases();

export const smokePixels = gpuComparisonPixels;

interface SmokeResult {
  name: string;
  success: boolean;
  comparison?: ReturnType<typeof compareRgba>;
  error?: string;
}
export interface SmokeState {
  running: boolean;
  adapter: string;
  device: string;
  shader: string;
  info: string;
  status: string;
  results: SmokeResult[];
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** One run owns its renderer, including devices that arrive after page departure. */
export class WebGpuSmoke {
  private renderer: Renderer | null = null;
  private initializingDevice: ExposureGpuDevice | null = null;
  private closed = false;
  readonly state: SmokeState = {
    running: false, adapter: '未取得', device: '未取得', shader: '未確認', info: '未取得',
    status: '未実行', results: [],
  };

  constructor(private environment: SmokeEnvironment, private update: (state: SmokeState) => void,
    private factory: Factory = WebGpuAdjustmentRenderer.create) {}

  dispose() {
    this.closed = true;
    this.renderer?.dispose();
    // create() has not returned its owner yet; destroy interrupts pending shader compilation.
    this.initializingDevice?.destroy();
    this.initializingDevice = null;
  }

  async run(): Promise<void> {
    if (this.closed || this.state.running) return;
    Object.assign(this.state, { running: true, adapter: '未取得', device: '未取得', shader: '未確認',
      info: '未取得', status: '実行中', results: [] });
    const publish = () => { if (!this.closed) this.update(this.state); };
    publish();
    let initializationError = '';
    try {
      if (!this.environment.secureContext) throw new Error('Secure Contextではありません。HTTPS等の安全なコンテキストで開いてください。');
      const gpu = this.environment.gpu;
      if (!gpu) throw new Error('navigator.gpuがありません。このブラウザ／環境ではWebGPUを利用できません。');
      const diagnosticGpu: ExposureGpu = {
        requestAdapter: async () => {
          let adapter: Awaited<ReturnType<SmokeGpu['requestAdapter']>>;
          try {
            adapter = await gpu.requestAdapter();
            this.state.adapter = adapter ? '成功' : '取得できませんでした（null）';
          } catch (error) {
            this.state.adapter = `失敗: ${errorText(error)}`;
            throw error;
          }
          publish();
          if (this.closed) throw new Error('画面離脱により中止');
          if (!adapter) throw new Error('利用可能なGPUアダプターがありません。');
          try {
            const info = adapter.info ?? await adapter.requestAdapterInfo?.();
            this.state.info = info ? ['vendor', 'architecture', 'device', 'description'].map(key =>
              `${key}: ${info[key as keyof AdapterInfo] || '（空文字／未公開）'}`).join('\n') : 'GPU情報APIなし';
          } catch (error) { this.state.info = `GPU情報を取得できませんでした: ${errorText(error)}`; }
          publish();
          return {
            requestDevice: async () => {
              if (this.closed) throw new Error('画面離脱により中止');
              try {
                const device = await adapter.requestDevice();
                if (this.closed) { device.destroy(); throw new Error('画面離脱により中止'); }
                this.initializingDevice = device;
                this.state.device = '成功';
                publish();
                return device;
              } catch (error) {
                this.state.device = `失敗: ${errorText(error)}`;
                publish();
                throw error;
              }
            },
          };
        },
      };
      this.renderer = await this.factory(diagnosticGpu, error => { initializationError = errorText(error); });
      this.initializingDevice = null;
      if (this.closed) return;
      if (!this.renderer) {
        if (this.state.device === '成功') this.state.shader = `初期化失敗: ${initializationError || '原因不明'}`;
        throw new Error(initializationError || 'WebGPUレンダラーを初期化できませんでした。');
      }
      this.state.shader = 'コンパイル・Pipeline作成成功';
      publish();
      const source = smokePixels();
      const generation = await this.renderer.setSource(source, 32, 16);
      for (const { name, recipe } of SMOKE_CASES) {
        if (this.closed) return;
        try {
          const cpu = renderAdjustments(source, recipe);
          const result = await this.renderer.render(recipe);
          if (result.sourceGeneration !== generation) throw new Error('GPU result source generation does not match the uploaded image.');
          if (this.closed) return;
          this.state.results.push({ name, success: true, comparison: compareRgba(cpu, result.pixels) });
        } catch (error) {
          if (this.closed) return;
          this.state.results.push({ name, success: false, error: errorText(error) });
        }
        publish();
      }
      this.state.status = this.state.results.every(result => result.success) ? 'GPU実行完了' : 'GPU実行失敗あり';
    } catch (error) {
      this.state.status = `利用不可／失敗: ${errorText(error)}`;
      this.state.results = SMOKE_CASES.map(({ name }) => ({ name, success: false, error: errorText(error) }));
    } finally {
      this.renderer?.dispose();
      this.renderer = null;
      this.initializingDevice?.destroy();
      this.initializingDevice = null;
      this.state.running = false;
      publish();
    }
  }
}

export function mountSmokePage(root: HTMLElement, environment: SmokeEnvironment, factory?: Factory) {
  root.innerHTML = `<h1>${i18n.t('webgpuSmoke.title')}</h1>
    <p>${i18n.t('webgpuSmoke.imageDescription')}</p>
    <p>Secure Context: <strong id="secure"></strong> / navigator.gpu: <strong id="gpu-api"></strong></p>
    <button type="button">スモークテストを実行</button>
    <pre id="diagnostics" aria-live="polite"></pre>
    <p>最大差と差異数はRGBA全チャンネルの生バイト比較です。差は自動合否判定せず実測値を表示します。</p>
    <p>${i18n.t('webgpuSmoke.numericNotes')}</p>
    <div class="results"><table><thead><tr><th>${i18n.t('webgpuSmoke.recipeCase')}</th><th>GPU実行</th><th>最大階調差</th>
    <th>差異チャンネル数</th><th>アルファ一致</th><th>エラー</th></tr></thead><tbody></tbody></table></div>`;
  root.querySelector('#secure')!.textContent = String(environment.secureContext);
  root.querySelector('#gpu-api')!.textContent = String(Boolean(environment.gpu));
  const button = root.querySelector('button')!;
  const show = (state: SmokeState) => {
    button.disabled = state.running;
    root.querySelector('#diagnostics')!.textContent = `アダプター: ${state.adapter}\nデバイス: ${state.device}\nWGSL: ${state.shader}\nGPU情報:\n${state.info}\n状態: ${state.status}`;
    const rows = SMOKE_CASES.map(({ name }) => state.results.find(result => result.name === name)
      ?? { name, success: false });
    const tbody = root.querySelector('tbody')!;
    tbody.replaceChildren(...rows.map(result => {
      const row = document.createElement('tr');
      const comparison = 'comparison' in result ? result.comparison : undefined;
      const error = 'error' in result ? result.error : undefined;
      const values = [ result.name,
        state.results.includes(result) ? (result.success ? '成功' : '失敗') : '未実行',
        comparison?.maximumDifference ?? '—', comparison?.differingChannels ?? '—',
        comparison ? (comparison.alphaMatches ? '一致' : '不一致') : '—', error ?? '—' ];
      for (const value of values) {
        const cell = document.createElement('td');
        // Browser-provided error messages and GPU strings are untrusted display text.
        cell.textContent = String(value);
        row.append(cell);
      }
      return row;
    }));
  };
  const smoke = new WebGpuSmoke(environment, show, factory);
  show(smoke.state);
  const run = () => { void smoke.run(); };
  button.addEventListener('click', run);
  return () => { button.removeEventListener('click', run); button.disabled = true; smoke.dispose(); };
}
