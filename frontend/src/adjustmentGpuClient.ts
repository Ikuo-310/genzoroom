import type { EditRecipe } from './editing';
import type { GpuAdjustmentResult } from './webgpuAdjustmentRenderer';
import type { WorkspaceGpuRenderer } from './useWorkspaceGpu';

/** The workspace owns the device; this client owns only one source/render sequence. */
export class AdjustmentGpuClient {
  private disposed = false;
  private failed = false;
  private running = false;
  private pending: EditRecipe | null = null;
  private generation: number | null = null;
  private lastRequestId = 0;

  constructor(private renderer: WorkspaceGpuRenderer, private pixels: ImageData, private callbacks: {
    onResult: (result: GpuAdjustmentResult) => void;
    onError: (error: unknown) => void;
    isCurrentRecipe: (recipe: EditRecipe) => boolean;
  }) {}

  render(recipe: EditRecipe) {
    if (this.disposed || this.failed) return;
    this.pending = recipe;
    if (!this.running) void this.drain();
  }
  dispose() { this.disposed = true; this.pending = null; }

  private async drain() {
    this.running = true;
    try {
      // Upload starts on the first scheduled render, avoiding work during StrictMode effect replay.
      if (this.generation === null) {
        this.generation = await this.renderer.setSource(this.pixels.data, this.pixels.width, this.pixels.height);
      }
      while (!this.disposed && this.pending) {
        const recipe = this.pending;
        this.pending = null;
        const result = await this.renderer.render(recipe);
        if (this.disposed) return;
        if (result.sourceGeneration !== this.generation || result.requestId <= this.lastRequestId
          || result.width !== this.pixels.width || result.height !== this.pixels.height) {
          throw new Error('WebGPU returned a stale or invalid image result');
        }
        this.lastRequestId = result.requestId;
        // The React Recipe may already have changed even before its next RAF request arrives.
        if (!this.pending && this.callbacks.isCurrentRecipe(recipe)) this.callbacks.onResult(result);
      }
    } catch (error) {
      if (!this.disposed) { this.failed = true; this.pending = null; this.callbacks.onError(error); }
    } finally { this.running = false; }
  }
}
