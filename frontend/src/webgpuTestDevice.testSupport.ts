import { vi } from 'vitest';
import type { ExposureGpu, ExposureGpuBuffer, ExposureGpuDevice } from './webgpuTypes';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function fakeGpu() {
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
