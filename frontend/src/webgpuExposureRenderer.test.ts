import { describe, expect, it, vi } from 'vitest';
import { renderAdjustments } from './adjustmentPipeline';
import { defaultRecipe } from './editing';
import { WebGpuExposureRenderer } from './webgpuExposureRenderer';
import { compareRgba } from './webgpuComparison';
import type { ExposureGpu, ExposureGpuBuffer, ExposureGpuDevice } from './webgpuTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeGpu() {
  const loss = deferred<{ message: string }>();
  const buffers: Array<{ bytes: ArrayBuffer; destroy: ReturnType<typeof vi.fn>; unmap: ReturnType<typeof vi.fn> }> = [];
  const pipeline = { getBindGroupLayout: vi.fn() };
  const dispatch = vi.fn();
  let bindings: Array<{ resource: { buffer: typeof buffers[number] } }> = [];
  let finishMap = () => Promise.resolve();
  const device = {
    lost: loss.promise,
    limits: { maxBufferSize: 1 << 20, maxStorageBufferBindingSize: 1 << 20, maxComputeWorkgroupsPerDimension: 4 },
    queue: {
      writeBuffer: vi.fn((buffer, offset, data) => new Uint8Array(buffer.bytes).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset)),
      submit: vi.fn(),
    },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async (): Promise<{ message: string } | null> => null),
    createShaderModule: vi.fn(), createComputePipelineAsync: vi.fn(async () => pipeline),
    createBuffer: vi.fn(({ size }) => {
      const buffer = { bytes: new ArrayBuffer(size), destroy: vi.fn(), unmap: vi.fn(),
        mapAsync: vi.fn(() => finishMap()), getMappedRange() { return this.bytes; } };
      buffers.push(buffer);
      return buffer;
    }),
    createBindGroup: vi.fn(({ entries }) => { bindings = entries; return {}; }),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: dispatch,
        // This mock copies bytes only. It does not execute or validate WGSL arithmetic.
        end: () => new Uint8Array(bindings[1].resource.buffer.bytes).set(new Uint8Array(bindings[0].resource.buffer.bytes)),
      }),
      copyBufferToBuffer: (source: ExposureGpuBuffer, _sourceOffset: number, target: ExposureGpuBuffer) => {
        const from = source as ExposureGpuBuffer & { bytes: ArrayBuffer };
        const to = target as ExposureGpuBuffer & { bytes: ArrayBuffer };
        new Uint8Array(to.bytes).set(new Uint8Array(from.bytes));
      },
      finish: vi.fn(),
    })),
    destroy: vi.fn(),
  } satisfies ExposureGpuDevice;
  const gpu: ExposureGpu = { requestAdapter: vi.fn(async () => ({ requestDevice: async () => device })) };
  return { gpu, device, buffers, loss, dispatch, unblockMap: () => { finishMap = () => Promise.resolve(); },
    blockMap: () => { const pending = deferred<void>(); finishMap = () => pending.promise; return pending; } };
}

function pixels(count: number) {
  return Uint8ClampedArray.from({ length: count * 4 }, (_, i) => (i * 73 + Math.floor(i / 4)) & 255);
}

describe('WebGPU lifecycle and transfer (mock device, no GPU execution)', () => {
  it('safely reports unavailable without an API or adapter', async () => {
    if (typeof navigator === 'undefined' || !(navigator as Navigator & { gpu?: ExposureGpu }).gpu) {
      expect(await WebGpuExposureRenderer.create()).toBeNull();
    }
    expect(await WebGpuExposureRenderer.create({ requestAdapter: async () => null })).toBeNull();
    expect(await WebGpuExposureRenderer.create({ requestAdapter: async () => { throw new Error('adapter'); } })).toBeNull();
    expect(await WebGpuExposureRenderer.create({ requestAdapter: async () => ({ requestDevice: async () => { throw new Error('device'); } }) })).toBeNull();
  });

  it('destroys the device when pipeline compilation fails', async () => {
    const fake = fakeGpu();
    fake.device.createComputePipelineAsync.mockRejectedValueOnce(new Error('shader'));
    const onError = vi.fn();
    expect(await WebGpuExposureRenderer.create(fake.gpu, onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith(new Error('shader'));
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    expect(fake.device.popErrorScope).toHaveBeenCalledTimes(3);
  });

  it.each(['validation', 'out-of-memory', 'internal'])('reports initialization %s errors as unavailable', async message => {
    const fake = fakeGpu();
    fake.device.popErrorScope.mockResolvedValueOnce({ message });
    expect(await WebGpuExposureRenderer.create(fake.gpu)).toBeNull();
    expect(fake.device.destroy).toHaveBeenCalledOnce();
  });

  it.each([[1, 1], [7, 3], [65, 1], [17, 33]])('transfers %ix%i RGBA and releases every buffer', async (width, height) => {
    const fake = fakeGpu();
    const renderer = (await WebGpuExposureRenderer.create(fake.gpu))!;
    const source = pixels(width * height);
    const original = source.slice();
    const result = await renderer.render(source, width, height, 0);
    expect(result).toEqual(original);
    expect(result.buffer).not.toBe(source.buffer);
    expect(source).toEqual(original);
    const groups = Math.ceil(width * height / 64);
    expect(fake.dispatch).toHaveBeenCalledWith(Math.min(groups, 4), Math.ceil(groups / 4));
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(fake.buffers[3].unmap).toHaveBeenCalledOnce();
    await renderer.render(source, width, height, 0.5);
    const params = new DataView(fake.buffers[6].bytes);
    expect(params.getFloat32(0, true)).toBe(Math.fround(2 ** 0.5));
    renderer.dispose(); renderer.dispose();
    expect(fake.device.destroy).toHaveBeenCalledOnce();
    expect(renderer.available).toBe(false);
    await expect(renderer.render(source, width, height, 0)).rejects.toThrow('disposed');
  });

  it('rejects invalid input and GPU limits before allocation', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuExposureRenderer.create(fake.gpu))!;
    for (const [width, height, exposure] of [[0, 1, 0], [1.5, 1, 0], [2, 1, 0], [1, 1, NaN], [1, 1, Infinity], [1, 1, 5.01], [1, 1, -5.01]]) {
      await expect(renderer.render(pixels(1), width, height, exposure)).rejects.toThrow(RangeError);
    }
    await expect(renderer.render(pixels(1025), 1025, 1, 0)).rejects.toThrow('dispatch');
    fake.device.limits.maxStorageBufferBindingSize = 3;
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('size');
    fake.device.limits.maxStorageBufferBindingSize = 1024;
    fake.device.limits.maxBufferSize = 3;
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('size');
    expect(fake.buffers).toHaveLength(0);
    renderer.dispose();
  });

  it('cleans partial allocation and scoped GPU errors', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuExposureRenderer.create(fake.gpu))!;
    const allocate = fake.device.createBuffer.getMockImplementation()!;
    fake.device.createBuffer.mockImplementationOnce(allocate).mockImplementationOnce(() => { throw new Error('allocation'); });
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('allocation');
    expect(fake.buffers[0].destroy).toHaveBeenCalledOnce();
    fake.device.popErrorScope.mockResolvedValueOnce({ message: 'validation' });
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('validation');
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it.each(['loss', 'dispose', 'map failure'])('handles %s during readback', async mode => {
    const fake = fakeGpu();
    const renderer = (await WebGpuExposureRenderer.create(fake.gpu))!;
    const pending = fake.blockMap();
    const work = renderer.render(pixels(1), 1, 1, 0);
    const rejection = expect(work).rejects.toThrow();
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('busy');
    if (mode === 'loss') fake.loss.resolve({ message: 'test loss' });
    else if (mode === 'dispose') renderer.dispose();
    else pending.reject(new Error('map failure'));
    await rejection;
    pending.resolve();
    await Promise.resolve();
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(renderer.available).toBe(mode === 'map failure');
    if (mode === 'map failure') {
      fake.unblockMap();
      expect(await renderer.render(pixels(1), 1, 1, 0)).toEqual(pixels(1));
    }
    renderer.dispose();
  });

  it('handles idle and initialization device loss', async () => {
    const fake = fakeGpu();
    const renderer = (await WebGpuExposureRenderer.create(fake.gpu))!;
    fake.loss.resolve({ message: 'idle' });
    await Promise.resolve();
    await expect(renderer.render(pixels(1), 1, 1, 0)).rejects.toThrow('lost');
    renderer.dispose();
    const starting = fakeGpu();
    starting.device.createComputePipelineAsync.mockImplementationOnce(() => new Promise(() => {}));
    const creation = WebGpuExposureRenderer.create(starting.gpu);
    starting.loss.resolve({ message: 'startup' });
    expect(await creation).toBeNull();
    expect(starting.device.destroy).toHaveBeenCalledOnce();
  });
});

// Arithmetic model only: Math.pow here cannot establish a real WGSL implementation's accuracy.
function float32Exposure(channel: number, exposure: number) {
  const f = Math.fround;
  const srgb = f(channel / 255);
  const linear = srgb <= f(0.04045) ? f(srgb / f(12.92)) : f(f(f(srgb + f(0.055)) / f(1.055)) ** f(2.4));
  const exposed = Math.min(1, f(linear * f(2 ** exposure)));
  const encoded = exposed <= f(0.0031308) ? f(f(12.92) * exposed)
    : f(f(f(1.055) * f(exposed ** f(1 / f(2.4)))) - f(0.055));
  return exposure === 0 ? channel : Math.floor(f(f(255 * Math.max(0, Math.min(1, encoded))) + 0.5));
}

it('compares an f32 arithmetic model against CPU for all bytes and supported 0.01 EV steps', () => {
  const source = Uint8ClampedArray.from({ length: 256 * 4 }, (_, i) => Math.floor(i / 4));
  let maximum = 0;
  let differing = 0;
  for (let step = -500; step <= 500; step++) {
    const exposure = step / 100;
    const recipe = defaultRecipe(); recipe.adjustments.exposure = exposure;
    const cpu = renderAdjustments(source, recipe);
    for (let channel = 0; channel < 256; channel++) {
      const difference = Math.abs(cpu[channel * 4] - float32Exposure(channel, exposure));
      maximum = Math.max(maximum, difference);
      if (difference) differing++;
    }
  }
  console.info(`f32 model only: maximum RGB byte difference=${maximum}, differing levels=${differing}/256256`);
  expect(maximum).toBeLessThanOrEqual(1);
});

const nativeGpu = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: ExposureGpu }).gpu;
describe.skipIf(!nativeGpu)('real WebGPU / CPU comparison (requires WebGPU test runtime)', () => {
  it('executes WGSL for sizes, alpha, all byte levels, EV endpoints and rounding boundaries', async () => {
    const renderer = await WebGpuExposureRenderer.create(nativeGpu);
    expect(renderer, 'API advertised but GPU initialization failed').not.toBeNull();
    let maximum = 0;
    let differing = 0;
    try {
      for (const [width, height] of [[1, 1], [7, 3], [65, 1], [17, 33], [256, 1]]) {
        const source = pixels(width * height);
        for (const exposure of [-5, -4.99, -1, -0.01, 0, 0.01, 0.5, 1, 4.99, 5,
          Math.log2(((10.5 / 255) / 12.92) / ((10 / 255) / 12.92))]) {
          const original = source.slice();
          const recipe = defaultRecipe(); recipe.adjustments.exposure = exposure;
          const cpu = renderAdjustments(source, recipe);
          const gpu = await renderer!.render(source, width, height, exposure);
          expect(source).toEqual(original);
          const comparison = compareRgba(cpu, gpu);
          expect(comparison.alphaMatches).toBe(true);
          expect(comparison.maximumDifference, `EV=${exposure}, size=${width}x${height}`).toBeLessThanOrEqual(1);
          if (exposure === 0) expect(comparison.differingChannels).toBe(0);
          maximum = Math.max(maximum, comparison.maximumDifference);
          differing += comparison.differingChannels;
        }
      }
      console.info(`Real GPU: maximum RGB byte difference=${maximum}, differing bytes=${differing}`);
    } finally { renderer?.dispose(); }
  });
});
