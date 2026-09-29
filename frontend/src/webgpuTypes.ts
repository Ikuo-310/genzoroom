// Local structural types keep this optional renderer independent of ambient WebGPU typings.
export interface ExposureGpuBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface ExposureGpuPipeline {
  getBindGroupLayout(index: number): unknown;
}

export interface ExposureGpuDevice {
  readonly lost: Promise<{ message: string }>;
  readonly limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxComputeWorkgroupsPerDimension: number;
  };
  readonly queue: {
    writeBuffer(buffer: ExposureGpuBuffer, offset: number, data: ArrayBufferView<ArrayBuffer>): void;
    submit(commands: unknown[]): void;
  };
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<{ message: string } | null>;
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipelineAsync(descriptor: {
    layout: 'auto'; compute: { module: unknown; entryPoint: string };
  }): Promise<ExposureGpuPipeline>;
  createBuffer(descriptor: { size: number; usage: number }): ExposureGpuBuffer;
  createBindGroup(descriptor: {
    layout: unknown; entries: Array<{ binding: number; resource: { buffer: ExposureGpuBuffer } }>;
  }): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: ExposureGpuPipeline): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(x: number, y: number): void;
      end(): void;
    };
    copyBufferToBuffer(source: ExposureGpuBuffer, sourceOffset: number,
      target: ExposureGpuBuffer, targetOffset: number, size: number): void;
    finish(): unknown;
  };
  destroy(): void;
}

export interface ExposureGpu {
  requestAdapter(): Promise<{ requestDevice(): Promise<ExposureGpuDevice> } | null>;
}
