import shader from './adjustments.wgsl?raw';
import type { EditRecipe } from './editing';
import { defaultGpu, scoped } from './webgpuExposureRenderer';
import { prepareGpuRecipe } from './webgpuRecipe';
import type { ExposureGpu, ExposureGpuBuffer, ExposureGpuDevice, ExposureGpuPipeline } from './webgpuTypes';

export interface GpuAdjustmentResult {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  sourceGeneration: number;
  requestId: number;
}

/** G2 owns one uploaded source. Failures reject; the caller retains its CPU fallback source. */
export class WebGpuAdjustmentRenderer {
  private stopped: Error | null = null;
  private disposed = false;
  private busy = false;
  private buffers = new Set<ExposureGpuBuffer>();
  private source: { buffer: ExposureGpuBuffer; width: number; height: number; columns: number; rows: number } | null = null;
  private generation = 0;
  private nextRequest = 0;
  private pipeline!: ExposureGpuPipeline;
  private interrupted: Promise<never>;
  private interrupt!: (error: Error) => void;

  private constructor(private device: ExposureGpuDevice) {
    this.interrupted = new Promise((_, reject) => { this.interrupt = reject; });
    void this.interrupted.catch(() => {});
    void device.lost.then(info => this.stop(new Error(`WebGPU device lost: ${info.message}`)));
  }

  static async create(gpu: ExposureGpu | undefined = defaultGpu(),
    onError?: (error: unknown) => void): Promise<WebGpuAdjustmentRenderer | null> {
    let renderer: WebGpuAdjustmentRenderer | undefined;
    try {
      const adapter = await gpu?.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      renderer = new WebGpuAdjustmentRenderer(device);
      renderer.pipeline = await Promise.race([scoped(device, () => device.createComputePipelineAsync({
        layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
      })), renderer.interrupted]);
      if (renderer.stopped) throw renderer.stopped;
      return renderer;
    } catch (error) {
      renderer?.dispose();
      onError?.(error);
      return null;
    }
  }

  get available() { return this.stopped === null; }
  get sourceGeneration() { return this.generation; }

  private ready() {
    if (this.stopped) throw this.stopped;
    // No implicit queue: reject overlap with upload or rendering, so error scopes cannot interleave.
    if (this.busy) throw new Error('WebGPU renderer busy');
  }
  private allocate(size: number, usage: number) {
    const buffer = this.device.createBuffer({ size, usage });
    this.buffers.add(buffer);
    return buffer;
  }
  private release(buffer: ExposureGpuBuffer) {
    if (this.buffers.delete(buffer)) buffer.destroy();
  }
  private stop(error: Error) {
    if (this.stopped) return;
    this.stopped = error;
    this.interrupt(error);
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers.clear();
    this.source = null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(new Error('WebGPU renderer disposed'));
    this.device.destroy();
  }

  async setSource(pixels: Uint8ClampedArray, width: number, height: number): Promise<number> {
    this.ready();
    const count = width * height;
    const size = count * 4;
    const limit = this.device.limits.maxComputeWorkgroupsPerDimension;
    const groups = Math.ceil(count / 64), columns = Math.min(groups, limit), rows = Math.ceil(groups / columns);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || !Number.isSafeInteger(size) || pixels.length !== size || count > 0xffffffc0
      || size > this.device.limits.maxBufferSize || size > this.device.limits.maxStorageBufferBindingSize
      || rows > limit || rows * columns * 64 > 0x100000000) throw new RangeError('Invalid RGBA image size or GPU limits');
    this.busy = true;
    // Replacing a source invalidates its generation even if the new upload fails.
    this.generation++;
    if (this.source) this.release(this.source.buffer);
    this.source = null;
    let buffer: ExposureGpuBuffer | undefined;
    try {
      await Promise.race([scoped(this.device, async () => {
        buffer = this.allocate(size, 128 | 8); // STORAGE | COPY_DST
        // Raw RGBA bytes have the little-endian layout of the WGSL packed u32 pixels.
        this.device.queue.writeBuffer(buffer, 0, new Uint8Array(pixels));
      }), this.interrupted]);
      if (this.stopped) throw this.stopped;
      this.source = { buffer: buffer!, width, height, columns, rows };
      return this.generation;
    } catch (error) {
      if (buffer) this.release(buffer);
      throw error;
    } finally { this.busy = false; }
  }

  async render(recipe: EditRecipe): Promise<GpuAdjustmentResult> {
    this.ready();
    const source = this.source;
    if (!source) throw new Error('WebGPU source is not initialized');
    // Preparation is synchronous: subsequent caller mutations cannot change this request's Recipe.
    const { parameters, luts } = prepareGpuRecipe(recipe);
    const sourceGeneration = this.generation, requestId = ++this.nextRequest;
    const size = source.width * source.height * 4;
    const view = new DataView(parameters);
    view.setUint32(0, size / 4, true);
    view.setUint32(4, source.columns, true);
    this.busy = true;
    try {
      const pixels = await Promise.race([scoped(this.device, async () => {
        const output = this.allocate(size, 128 | 4); // STORAGE | COPY_SRC
        const uniform = this.allocate(parameters.byteLength, 64 | 8); // UNIFORM | COPY_DST
        const table = this.allocate(luts.byteLength, 128 | 8);
        const readback = this.allocate(size, 1 | 8); // MAP_READ | COPY_DST
        this.device.queue.writeBuffer(uniform, 0, new Uint8Array(parameters));
        this.device.queue.writeBuffer(table, 0, luts);
        const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries:
          [source.buffer, output, uniform, table].map((buffer, binding) => ({ binding, resource: { buffer } })) });
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(source.columns, source.rows);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        if (this.stopped) throw this.stopped;
        const result = new Uint8ClampedArray(readback.getMappedRange()).slice();
        readback.unmap();
        return result;
      }), this.interrupted]);
      if (this.stopped) throw this.stopped;
      return { pixels, width: source.width, height: source.height, sourceGeneration, requestId };
    } finally {
      // Only the uploaded source survives a render; failed transient buffers are never cached.
      for (const buffer of this.buffers) if (buffer !== this.source?.buffer) this.release(buffer);
      this.busy = false;
    }
  }
}
