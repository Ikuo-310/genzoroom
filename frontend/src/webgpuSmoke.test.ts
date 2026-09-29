// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderAdjustments } from './adjustmentPipeline';
import type { EditRecipe } from './editing';
import type { GpuAdjustmentResult } from './webgpuAdjustmentRenderer';
import i18n from './i18n';
import { compareRgba } from './webgpuComparison';
import { mountSmokePage, SMOKE_CASES, smokePixels, WebGpuSmoke, type SmokeEnvironment } from './webgpuSmoke';
import type { ExposureGpu, ExposureGpuDevice } from './webgpuTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(info: object = { vendor: '', architecture: '', device: '', description: '' }) {
  const device = { destroy: vi.fn() } as unknown as ExposureGpuDevice;
  const adapter = { info, requestDevice: vi.fn(async () => device) };
  const gpu = { requestAdapter: vi.fn(async () => adapter) };
  let uploaded = smokePixels();
  const renderer = {
    setSource: vi.fn(async (source: Uint8ClampedArray, _width: number, _height: number) => { uploaded = source.slice(); return 1; }),
    // Mock CPU-produced outputs verify smoke orchestration, not WGSL execution.
    render: vi.fn(async (recipe: EditRecipe): Promise<GpuAdjustmentResult> => ({
      pixels: renderAdjustments(uploaded, recipe), width: 32, height: 16, sourceGeneration: 1, requestId: 1,
    })),
    dispose: vi.fn(),
  };
  const factory = vi.fn(async (instrumented: ExposureGpu, _onError: (error: unknown) => void) => {
    const found = await instrumented.requestAdapter();
    await found?.requestDevice();
    return renderer;
  });
  const environment: SmokeEnvironment = { secureContext: true, gpu };
  const update = vi.fn();
  const smoke = new WebGpuSmoke(environment, update, factory);
  return { device, adapter, gpu, renderer, factory, environment, update, smoke };
}

describe('byte comparison shared with G1', () => {
  it('reports maximum difference, channel count and alpha independently', () => {
    const source = new Uint8ClampedArray([0, 10, 255, 64, 100, 50, 3, 0]);
    expect(compareRgba(source, source.slice())).toEqual({ maximumDifference: 0, differingChannels: 0, alphaMatches: true });
    const output = source.slice(); output[0] = 1; output[1] = 8;
    expect(compareRgba(source, output)).toEqual({ maximumDifference: 2, differingChannels: 2, alphaMatches: true });
    output[7] = 255;
    expect(compareRgba(source, output)).toEqual({ maximumDifference: 255, differingChannels: 3, alphaMatches: false });
    expect(() => compareRgba(source, new Uint8ClampedArray(4))).toThrow('lengths');
    expect(() => compareRgba(new Uint8ClampedArray(1), new Uint8ClampedArray(1))).toThrow('lengths');
  });
});

it('localizes G2 UI additions through the existing language resources', async () => {
  const original = i18n.language;
  try {
    for (const language of ['en', 'ja']) {
      await i18n.changeLanguage(language);
      const root = document.createElement('main');
      const cleanup = mountSmokePage(root, { secureContext: true });
      expect(root.querySelector('h1')!.textContent).toBe(i18n.t('webgpuSmoke.title'));
      expect(root.textContent).toContain(i18n.t('webgpuSmoke.numericNotes'));
      expect(root.textContent).toContain(i18n.t('webgpuSmoke.recipeCase'));
      expect(root.textContent).not.toContain('webgpuSmoke.');
      cleanup();
    }
  } finally { await i18n.changeLanguage(original); }
});

describe('smoke diagnostics and lifecycle (mock renderer, no GPU execution)', () => {
  it('uses one uploaded image and all Recipe cases with serial CPU comparisons', async () => {
    const fake = setup();
    let active = 0;
    const render = fake.renderer.render.getMockImplementation()!;
    fake.renderer.render.mockImplementation(async (...args) => {
      expect(active++).toBe(0);
      await Promise.resolve();
      const output = await render(...args);
      active--;
      return output;
    });
    await fake.smoke.run();
    expect(fake.renderer.setSource).toHaveBeenCalledExactlyOnceWith(smokePixels(), 32, 16);
    expect(fake.renderer.render.mock.calls.map(call => call[0])).toEqual(SMOKE_CASES.map(c => c.recipe));
    expect(fake.smoke.state.results).toHaveLength(SMOKE_CASES.length);
    for (const row of fake.smoke.state.results) {
      expect(row.success).toBe(true);
      expect(row.comparison).toEqual({ maximumDifference: 0, differingChannels: 0, alphaMatches: true });
    }
    expect(fake.smoke.state.adapter).toBe('成功');
    expect(fake.smoke.state.device).toBe('成功');
    expect(fake.smoke.state.info).toContain('（空文字／未公開）');
    expect(fake.renderer.dispose).toHaveBeenCalledOnce();
    expect(smokePixels()).toHaveLength(2048);
    const tuples = Array.from({ length: 512 }, (_, i) => [...smokePixels().slice(i * 4, i * 4 + 4)]);
    for (const rgb of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255]]) {
      expect(tuples.some(pixel => pixel.slice(0, 3).join() === rgb.join())).toBe(true);
    }
    expect(new Set(tuples.map(pixel => pixel[3])).size).toBeGreaterThan(2);
  });

  it.each([
    [{ secureContext: false }, 'Secure Context'],
    [{ secureContext: true }, 'navigator.gpu'],
  ] satisfies Array<[SmokeEnvironment, string]>)('explains preflight unavailability', async (environment, reason) => {
    const fake = setup();
    const smoke = new WebGpuSmoke(environment, vi.fn(), fake.factory);
    await smoke.run();
    expect(fake.factory).not.toHaveBeenCalled();
    expect(smoke.state.status).toContain(reason);
    expect(smoke.state.results.every(row => !row.success && row.error?.includes(reason))).toBe(true);
  });

  it.each(['adapter null', 'adapter error', 'device error', 'shader error'])('displays %s', async mode => {
    const fake = setup();
    const factory = async (gpu: ExposureGpu, onError: (error: unknown) => void) => {
      try {
        const adapter = await gpu.requestAdapter();
        await adapter?.requestDevice();
        throw new Error('shader error: WGSL validation');
      } catch (error) { onError(error); return null; }
    };
    if (mode === 'adapter null') fake.gpu.requestAdapter.mockResolvedValueOnce(null as never);
    if (mode === 'adapter error') fake.gpu.requestAdapter.mockRejectedValueOnce(new Error(mode));
    if (mode === 'device error') fake.adapter.requestDevice.mockRejectedValueOnce(new Error(mode));
    const smoke = new WebGpuSmoke(fake.environment, vi.fn(), factory);
    await smoke.run();
    expect(smoke.state.results).toHaveLength(SMOKE_CASES.length);
    expect(smoke.state.results.every(row => !row.success)).toBe(true);
    expect(smoke.state.status).toContain(mode === 'adapter null' ? 'GPUアダプター' : mode);
    if (mode === 'shader error') expect(smoke.state.shader).toContain('WGSL validation');
  });

  it('continues after a render failure and reports alpha differences', async () => {
    const fake = setup();
    const alphaMismatch = smokePixels(); alphaMismatch[3] = 255;
    fake.renderer.render.mockRejectedValueOnce(new Error('device lost')).mockResolvedValueOnce({ pixels: alphaMismatch, width: 32, height: 16, sourceGeneration: 1, requestId: 2 });
    await fake.smoke.run();
    expect(fake.smoke.state.results[0].error).toBe('device lost');
    expect(fake.smoke.state.results[1].comparison?.alphaMatches).toBe(false);
    expect(fake.smoke.state.status).toContain('失敗');
    expect(fake.renderer.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps GPU info retrieval optional (failure=%s)', async fail => {
    const fake = setup();
    const gpu: NonNullable<SmokeEnvironment['gpu']> = {
      requestAdapter: async () => ({ requestDevice: fake.adapter.requestDevice,
        requestAdapterInfo: async () => {
          if (fail) throw new Error('GPU info restricted');
          return { vendor: 'test vendor', description: '' };
        },
      }),
    };
    const smoke = new WebGpuSmoke({ secureContext: true, gpu }, vi.fn(), fake.factory);
    await smoke.run();
    expect(smoke.state.info).toContain(fail ? 'GPU info restricted' : 'test vendor');
    expect(smoke.state.results.every(row => row.success)).toBe(true);
    expect(fake.renderer.dispose).toHaveBeenCalledOnce();
  });

  it('prevents duplicate runs, disposes on departure and suppresses late results', async () => {
    const fake = setup();
    const pending = deferred<GpuAdjustmentResult>();
    const started = deferred<void>();
    fake.renderer.render.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const work = fake.smoke.run();
    await started.promise;
    await fake.smoke.run();
    expect(fake.factory).toHaveBeenCalledOnce();
    fake.smoke.dispose();
    const updates = fake.update.mock.calls.length;
    expect(fake.renderer.dispose).toHaveBeenCalled();
    pending.resolve({ pixels: smokePixels(), width: 32, height: 16, sourceGeneration: 1, requestId: 1 });
    await work;
    expect(fake.smoke.state.results).toHaveLength(0);
    expect(fake.update).toHaveBeenCalledTimes(updates);
    expect(fake.renderer.render).toHaveBeenCalledOnce();
    await fake.smoke.run();
    expect(fake.factory).toHaveBeenCalledOnce();
  });

  it('destroys a device returned after departure', async () => {
    const fake = setup();
    const pending = deferred<ExposureGpuDevice>();
    const requested = deferred<void>();
    fake.adapter.requestDevice.mockImplementationOnce(() => { requested.resolve(); return pending.promise; });
    const work = fake.smoke.run();
    await requested.promise;
    fake.smoke.dispose();
    pending.resolve(fake.device);
    await work;
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    expect(fake.renderer.render).not.toHaveBeenCalled();
  });

  it('destroys an initializing device and disposes a late renderer', async () => {
    const fake = setup();
    const pending = deferred<typeof fake.renderer>();
    const acquired = deferred<void>();
    fake.factory.mockImplementationOnce(async gpu => {
      const adapter = await gpu.requestAdapter();
      await adapter!.requestDevice();
      acquired.resolve();
      return pending.promise;
    });
    const work = fake.smoke.run();
    await acquired.promise;
    fake.smoke.dispose();
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    pending.resolve(fake.renderer);
    await work;
    expect(fake.renderer.dispose).toHaveBeenCalledOnce();
    expect(fake.renderer.render).not.toHaveBeenCalled();
  });
});

it('renders diagnostic errors as text and removes execution handlers on cleanup', async () => {
  const fake = setup();
  const root = document.createElement('main');
  const done = deferred<void>();
  fake.factory.mockImplementationOnce(async (_gpu, onError) => {
    onError(new Error('<img src=x onerror=alert(1)> WGSL'));
    done.resolve();
    return null as never;
  });
  const cleanup = mountSmokePage(root, fake.environment, fake.factory);
  expect(root.querySelectorAll('tbody tr')).toHaveLength(SMOKE_CASES.length);
  expect(root.textContent).toContain('未実行');
  root.querySelector('button')!.click();
  expect(root.querySelector('button')!.disabled).toBe(true);
  await done.promise;
  await Promise.resolve();
  expect(root.textContent).toContain('<img src=x onerror=alert(1)> WGSL');
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelectorAll('tbody tr')).toHaveLength(SMOKE_CASES.length);
  cleanup();
  root.querySelector('button')!.click();
  expect(fake.factory).toHaveBeenCalledOnce();
});
