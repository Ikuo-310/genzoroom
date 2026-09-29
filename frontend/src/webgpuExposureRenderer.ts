import shader from './exposure.wgsl?raw';
import { EXPOSURE } from './editing';
import type { ExposureGpu, ExposureGpuBuffer, ExposureGpuDevice, ExposureGpuPipeline } from './webgpuTypes';

// WebGPU bit flags are fixed by the API; no browser globals are needed at module load.
const USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

function defaultGpu(): ExposureGpu | undefined {
  return typeof navigator === 'undefined' ? undefined
    : (navigator as Navigator & { gpu?: ExposureGpu }).gpu;
}

async function scoped<T>(device: ExposureGpuDevice, action: () => Promise<T>): Promise<T> {
  device.pushErrorScope('internal');
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  try {
    return await action();
  } finally {
    const errors = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]);
    const error = errors.find(Boolean);
    if (error) throw new Error(error.message);
  }
}

/** Owns one device. Call dispose when finished; no resources are cached globally. */
export class WebGpuExposureRenderer {
  private stopped: Error | null = null;
  private busy = false;
  private disposed = false;
  private buffers = new Set<ExposureGpuBuffer>();
  private interrupted: Promise<never>;
  private interrupt!: (error: Error) => void;

  private constructor(private device: ExposureGpuDevice) {
    this.interrupted = new Promise((_, reject) => { this.interrupt = reject; });
    // Loss can occur while idle, so the rejection must already have a handler.
    void this.interrupted.catch(() => {});
    void device.lost.then(info => this.stop(new Error(`WebGPU device lost: ${info.message}`)));
  }

  private pipeline!: ExposureGpuPipeline;

  static async create(gpu: ExposureGpu | undefined = defaultGpu()): Promise<WebGpuExposureRenderer | null> {
    let renderer: WebGpuExposureRenderer | undefined;
    try {
      const adapter = await gpu?.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      renderer = new WebGpuExposureRenderer(device);
      renderer.pipeline = await Promise.race([scoped(device, () => device.createComputePipelineAsync({
        layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
      })), renderer.interrupted]);
      if (renderer.stopped) throw renderer.stopped;
      return renderer;
    } catch {
      renderer?.dispose();
      return null;
    }
  }

  get available(): boolean { return this.stopped === null; }

  private stop(error: Error) {
    if (this.stopped) return;
    this.stopped = error;
    this.interrupt(error);
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(new Error('WebGPU renderer disposed'));
    this.device.destroy();
  }

  async render(source: Uint8ClampedArray, width: number, height: number, exposure: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
    if (this.stopped) throw this.stopped;
    // Concurrent scopes share device state; explicitly reject overlap instead of retaining a work queue.
    if (this.busy) throw new Error('WebGPU renderer busy');
    const pixels = width * height;
    const size = pixels * 4;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || !Number.isSafeInteger(size) || size !== source.length
      || pixels > 0xffffffff || size > this.device.limits.maxBufferSize
      || size > this.device.limits.maxStorageBufferBindingSize) throw new RangeError('Invalid RGBA image size');
    // Accept finite EV directly, as the CPU pipeline does, within the supported Recipe range.
    if (!Number.isFinite(exposure) || exposure < EXPOSURE.min || exposure > EXPOSURE.max) {
      throw new RangeError('Invalid exposure');
    }
    const groups = Math.ceil(pixels / 64);
    const columns = Math.min(groups, this.device.limits.maxComputeWorkgroupsPerDimension);
    const rows = Math.ceil(groups / columns);
    if (rows > this.device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError('Image exceeds dispatch limits');
    this.busy = true;
    try {
      return await Promise.race([scoped(this.device, async () => {
        const allocate = (size: number, usage: number) => {
          const buffer = this.device.createBuffer({ size, usage });
          this.buffers.add(buffer);
          return buffer;
        };
        const input = allocate(size, USAGE.STORAGE | USAGE.COPY_DST);
        const output = allocate(size, USAGE.STORAGE | USAGE.COPY_SRC);
        const parameters = allocate(16, USAGE.UNIFORM | USAGE.COPY_DST);
        const readback = allocate(size, USAGE.MAP_READ | USAGE.COPY_DST);
        // Explicit packing avoids host endianness, texture sRGB conversion, and alpha premultiplication.
        const packed = new Uint8Array(size);
        const packedView = new DataView(packed.buffer);
        for (let i = 0; i < pixels; i++) {
          const offset = i * 4;
          packedView.setUint32(offset, source[offset] | (source[offset + 1] << 8)
            | (source[offset + 2] << 16) | (source[offset + 3] << 24), true);
        }
        const values = new ArrayBuffer(16);
        const view = new DataView(values);
        view.setFloat32(0, 2 ** exposure, true);
        view.setUint32(4, pixels, true);
        view.setUint32(8, columns, true);
        this.device.queue.writeBuffer(input, 0, packed);
        this.device.queue.writeBuffer(parameters, 0, new Uint8Array(values));
        const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries:
          [input, output, parameters].map((buffer, binding) => ({ binding, resource: { buffer } })) });
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(columns, rows);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        if (this.stopped) throw this.stopped;
        const mapped = new DataView(readback.getMappedRange());
        const result = new Uint8ClampedArray(size);
        for (let i = 0; i < pixels; i++) {
          const rgba = mapped.getUint32(i * 4, true);
          result.set([rgba & 255, (rgba >>> 8) & 255, (rgba >>> 16) & 255, rgba >>> 24], i * 4);
        }
        readback.unmap();
        return result;
      }), this.interrupted]);
    } finally {
      for (const buffer of this.buffers) buffer.destroy();
      this.buffers.clear();
      this.busy = false;
    }
  }
}
