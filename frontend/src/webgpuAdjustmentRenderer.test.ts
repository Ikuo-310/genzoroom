import { describe, expect, it, vi } from 'vitest';
import { renderAdjustments } from './adjustmentPipeline';
import { ADJUSTMENT_IDS, defaultRecipe, effectiveAdjustments } from './editing';
import { collectHistogram } from './histogram';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import { compareRgba } from './webgpuComparison';
import { defaultGpu } from './webgpuExposureRenderer';
import { prepareGpuRecipe } from './webgpuRecipe';
import { gpuComparisonPixels, gpuRecipeCases } from './webgpuRecipeCases';
import { modelGpuRecipe } from './webgpuRecipeModel.testSupport';
import { deferred, fakeGpu } from './webgpuTestDevice.testSupport';
import type { ExposureGpuDevice } from './webgpuTypes';

describe('G3 renderer ownership (mock device, not GPU execution)', () => {
  it('does not request an adapter after initialization is cancelled', async () => {
    const fake = fakeGpu(), controller = new AbortController(); controller.abort();
    expect(await WebGpuAdjustmentRenderer.create(fake.gpu, undefined, controller.signal)).toBeNull();
    expect(fake.gpu.requestAdapter).not.toHaveBeenCalled();
  });
  it('destroys a device acquired after its owner has left', async () => {
    const fake = fakeGpu(), pending = deferred<ExposureGpuDevice>(), controller = new AbortController();
    const gpu = { requestAdapter: async () => ({ requestDevice: () => pending.promise }) };
    const creating = WebGpuAdjustmentRenderer.create(gpu, undefined, controller.signal);
    await Promise.resolve(); controller.abort(); pending.resolve(fake.device);
    expect(await creating).toBeNull(); expect(fake.device.destroy).toHaveBeenCalledOnce();
    expect(fake.device.createComputePipelineAsync).not.toHaveBeenCalled();
  });
  it('releases a device while pipeline creation is still pending', async () => {
    const fake = fakeGpu(), controller = new AbortController();
    const pending = deferred<Awaited<ReturnType<typeof fake.device.createComputePipelineAsync>>>();
    fake.device.createComputePipelineAsync.mockReturnValue(pending.promise);
    const creating = WebGpuAdjustmentRenderer.create(fake.gpu, undefined, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    expect(fake.device.createComputePipelineAsync).toHaveBeenCalledOnce();
    controller.abort();
    expect(await creating).toBeNull(); expect(fake.device.destroy).toHaveBeenCalledOnce();
    pending.resolve({ getBindGroupLayout: vi.fn() });
  });
  it('notifies idle device loss, supports unsubscribe, and rejects later processing', async () => {
    const fake = fakeGpu(), renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!;
    const listener = vi.fn(), removed = vi.fn();
    renderer.onDeviceLost(listener); renderer.onDeviceLost(removed)();
    fake.loss.resolve({ message: 'Device removed' }); await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'WebGPU device lost: Device removed' }));
    expect(removed).not.toHaveBeenCalled(); expect(renderer.available).toBe(false);
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('Device removed');
    renderer.dispose(); expect(fake.device.destroy).toHaveBeenCalledOnce();
  });
  it('does not report intentional device disposal as a runtime failure', async () => {
    const fake = fakeGpu(), renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!, listener = vi.fn();
    renderer.onDeviceLost(listener); renderer.dispose();
    fake.loss.resolve({ message: 'Destroyed' }); await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('G2 CPU-derived tables and arithmetic models (not GPU execution)', () => {
  it.each(gpuRecipeCases())('preserves CPU stage order in double arithmetic: $name', ({ recipe }) => {
    const source = gpuComparisonPixels();
    expect(modelGpuRecipe(source, recipe, false)).toEqual(renderAdjustments(source, recipe));
  });

  it('measures f32 model differences per Recipe without imposing a GPU tolerance', () => {
    const source = gpuComparisonPixels();
    const differences = gpuRecipeCases().map(({ name, recipe }) => {
      const cpu = renderAdjustments(source, recipe), modeled = modelGpuRecipe(source, recipe, true);
      const first = cpu.findIndex((v, i) => v !== modeled[i]);
      return { name, ...compareRgba(cpu, modeled), firstDifference: first < 0 ? null : {
        pixel: Math.floor(first / 4), channel: first % 4, cpu: cpu[first], model: modeled[first],
      } };
    });
    expect(differences.every(value => value.alphaMatches)).toBe(true);
    console.info('G2 f32 arithmetic model only:', JSON.stringify(differences.filter(value => value.maximumDifference)));
  });

  it('reuses effectiveAdjustments for disabled controls and categories', () => {
    const all = gpuRecipeCases().find(value => value.name === 'All sixteen adjustments')!.recipe;
    for (const id of ADJUSTMENT_IDS) {
      const recipe = structuredClone(all); recipe.adjustmentEnabled[id] = false;
      const explicit = defaultRecipe(); Object.assign(explicit.adjustments, effectiveAdjustments(recipe));
      expect(prepareGpuRecipe(recipe)).toEqual(prepareGpuRecipe(explicit));
    }
    for (const test of gpuRecipeCases().filter(value => value.name.includes('Enabled OFF'))) {
      const explicit = defaultRecipe(); Object.assign(explicit.adjustments, effectiveAdjustments(test.recipe));
      expect(prepareGpuRecipe(test.recipe)).toEqual(prepareGpuRecipe(explicit));
    }
  });

  it('snapshots Recipe, does not mutate input, and preserves identity tables', () => {
    const recipe = defaultRecipe();
    const prepared = prepareGpuRecipe(recipe);
    for (let stage = 0; stage < 3; stage++) for (let value = 0; value < 256; value++) {
      expect([...prepared.luts.slice(stage * 1024 + value * 4, stage * 1024 + value * 4 + 4)]).toEqual([value, value, value, 255]);
    }
    expect(recipe).toEqual(defaultRecipe());
    const before = new Uint8Array(prepared.parameters).slice();
    recipe.adjustments.shadowsTint = 100;
    expect(new Uint8Array(prepared.parameters)).toEqual(before);
    expect(new DataView(prepareGpuRecipe(recipe).parameters).getUint32(40, true)).toBe(2);
  });

  it('packs the WGSL uniform ABI, including separate 3WAY activation bits', () => {
    const recipe = defaultRecipe();
    Object.assign(recipe.adjustments, { highlights: -50, whites: 25, shadows: 75, blacks: -100,
      vibrance: 40, saturation: -20 });
    const data = new DataView(prepareGpuRecipe(recipe).parameters);
    expect(data.byteLength).toBe(96);
    expect([16, 20, 24, 28, 32, 36].map(offset => data.getFloat32(offset, true)))
      .toEqual([-0.5, 0.25, 0.75, -1, Math.fround(0.4), Math.fround(0.8)]);
    for (const [index, id] of ['shadowsTemperature', 'shadowsTint', 'midtonesTemperature', 'midtonesTint',
      'highlightsTemperature', 'highlightsTint'].entries()) {
      const one = defaultRecipe(); one.adjustments[id as keyof typeof one.adjustments] = 100;
      const packed = new DataView(prepareGpuRecipe(one).parameters);
      expect(packed.getUint32(40, true)).toBe(1 << index);
      const offset = 48 + Math.floor(index / 2) * 16;
      expect(packed.getFloat32(offset + (index % 2 ? 8 : 0), true))
        .toBe(Math.fround(index % 2 ? 1.3 : 1 / 1.5));
    }
  });
});

describe('G2 resource ownership (mock device, no WGSL execution)', () => {
  it('reuses one uploaded source across Recipes and returns identifiable histogram-compatible buffers', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!;
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('source');
    const source = gpuComparisonPixels(), original = source.slice();
    const generation = await renderer.setSource(source, 32, 16);
    const input = fake.buffers[0];
    const first = await renderer.render(defaultRecipe());
    const second = await renderer.render(defaultRecipe());
    expect(first.pixels).toEqual(original);
    expect(source).toEqual(original);
    expect(first.sourceGeneration).toBe(generation);
    expect(second.requestId).toBeGreaterThan(first.requestId);
    expect(collectHistogram(first.pixels)).toEqual(collectHistogram(original));
    expect(fake.device.queue.writeBuffer.mock.calls.filter(call => call[0] === input)).toHaveLength(1);
    expect(input.destroy).not.toHaveBeenCalled();
    for (const buffer of fake.buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledOnce();
    source.fill(0);
    expect(first.pixels).toEqual(original);
    const next = await renderer.setSource(source, 32, 16);
    expect(next).toBeGreaterThan(generation);
    expect(input.destroy).toHaveBeenCalledOnce();
    renderer.dispose(); renderer.dispose();
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    await expect(renderer.setSource(source, 32, 16)).rejects.toThrow('disposed');
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('disposed');
  });

  it.each(['loss', 'dispose', 'map failure'])('rejects overlap and handles %s while rendering', async mode => {
    const fake = fakeGpu();
    const renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!;
    await renderer.setSource(gpuComparisonPixels(), 32, 16);
    const pending = fake.blockMap();
    const recipe = defaultRecipe(); recipe.adjustments.highlights = 50;
    const work = renderer.render(recipe);
    const failure = expect(work).rejects.toThrow();
    recipe.adjustments.highlights = -100;
    expect(new DataView(fake.buffers[2].bytes).getFloat32(16, true)).toBe(0.5);
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('busy');
    await expect(renderer.setSource(gpuComparisonPixels(), 32, 16)).rejects.toThrow('busy');
    if (mode === 'loss') fake.loss.resolve({ message: 'test loss' });
    else if (mode === 'dispose') renderer.dispose();
    else pending.reject(new Error('mapping rejected'));
    await failure;
    pending.resolve();
    if (mode === 'map failure') {
      expect(fake.buffers[0].destroy).not.toHaveBeenCalled();
      fake.unblockMap();
      await renderer.render(defaultRecipe());
    } else {
      await expect(renderer.render(defaultRecipe())).rejects.toThrow();
      expect(renderer.available).toBe(false);
    }
    renderer.dispose();
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates a failed source replacement and releases partial rendering allocations', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!;
    const source = gpuComparisonPixels();
    await renderer.setSource(source, 32, 16);
    fake.device.popErrorScope.mockResolvedValueOnce({ message: 'upload failed' });
    await expect(renderer.setSource(source, 32, 16)).rejects.toThrow('upload failed');
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('source');
    await renderer.setSource(source, 32, 16);
    const allocate = fake.device.createBuffer.getMockImplementation()!;
    fake.device.createBuffer.mockImplementationOnce(allocate).mockImplementationOnce(() => { throw new Error('allocation'); });
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('allocation');
    fake.device.popErrorScope.mockResolvedValueOnce({ message: 'validation' });
    await expect(renderer.render(defaultRecipe())).rejects.toThrow('validation');
    await renderer.render(defaultRecipe());
    renderer.dispose();
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it('reports initialization failures and releases failed devices', async () => {
    expect(await WebGpuAdjustmentRenderer.create({ requestAdapter: async () => null })).toBeNull();
    expect(await WebGpuAdjustmentRenderer.create({ requestAdapter: async () => { throw new Error('adapter'); } })).toBeNull();
    expect(await WebGpuAdjustmentRenderer.create({ requestAdapter: async () => ({ requestDevice: async () => { throw new Error('device'); } }) })).toBeNull();
    const fake = fakeGpu(), error = vi.fn();
    fake.device.createComputePipelineAsync.mockRejectedValueOnce(new Error('WGSL failed'));
    expect(await WebGpuAdjustmentRenderer.create(fake.gpu, error)).toBeNull();
    expect(error).toHaveBeenCalledWith(new Error('WGSL failed'));
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    const lost = fakeGpu();
    lost.device.createComputePipelineAsync.mockImplementationOnce(() => new Promise(() => {}));
    const creation = WebGpuAdjustmentRenderer.create(lost.gpu);
    lost.loss.resolve({ message: 'initialization lost' });
    expect(await creation).toBeNull();
    expect(lost.device.destroy).toHaveBeenCalledOnce();
  });

  it('rejects invalid sizes and Recipes before submission', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuAdjustmentRenderer.create(fake.gpu))!;
    await expect(renderer.setSource(new Uint8ClampedArray(4), 0, 1)).rejects.toThrow(RangeError);
    await expect(renderer.setSource(new Uint8ClampedArray(4), 1.5, 1)).rejects.toThrow(RangeError);
    await expect(renderer.setSource(new Uint8ClampedArray(4100), 1025, 1)).rejects.toThrow(RangeError);
    await renderer.setSource(new Uint8ClampedArray(4), 1, 1);
    const recipe = defaultRecipe(); recipe.adjustments.exposure = NaN;
    await expect(renderer.render(recipe)).rejects.toThrow('exposure');
    expect(fake.device.queue.submit).not.toHaveBeenCalled();
    renderer.dispose();
  });
});

describe.skipIf(!defaultGpu())('G2 actual WebGPU comparison (requires a WebGPU runtime)', () => {
  it('executes all cases and reports differences without automatic pixel tolerance', async () => {
    const renderer = await WebGpuAdjustmentRenderer.create();
    expect(renderer).not.toBeNull();
    try {
      const source = gpuComparisonPixels();
      await renderer!.setSource(source, 32, 16);
      for (const { name, recipe } of gpuRecipeCases()) {
        const result = await renderer!.render(recipe);
        const comparison = compareRgba(renderAdjustments(source, recipe), result.pixels);
        console.info(name, comparison);
        expect(comparison.alphaMatches).toBe(true);
        if (name === 'All adjustments disabled' || name === 'All adjustments at defaults') expect(comparison.maximumDifference).toBe(0);
      }
    } finally { renderer?.dispose(); }
  });
});
