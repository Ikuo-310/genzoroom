import type { EditRecipe } from './editing';
import type {
  AdjustmentWorkerInitMessage,
  AdjustmentWorkerRenderMessage,
  AdjustmentWorkerResponse,
  AdjustmentWorkerResultMessage,
} from './adjustmentWorkerProtocol';

export type AdjustmentWorkerLike = {
  onmessage: ((event: MessageEvent<AdjustmentWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: AdjustmentWorkerInitMessage | AdjustmentWorkerRenderMessage, transfer: Transferable[]): void;
  terminate(): void;
};

type Callbacks = {
  onResult: (result: AdjustmentWorkerResultMessage) => void;
  onError: (error: Error) => void;
};

export class AdjustmentWorkerClient {
  private inFlight: { requestId: number; assetGeneration: number } | null = null;
  private pendingLatest: EditRecipe | null = null;
  private nextRequestId = 1;
  private disposed = false;
  private failed = false;

  constructor(
    private readonly worker: AdjustmentWorkerLike,
    private readonly assetGeneration: number,
    private readonly callbacks: Callbacks,
  ) {
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = (event) => this.fail(new Error(event.message || 'Adjustment worker failed.'));
    worker.onmessageerror = () => this.fail(new Error('Adjustment worker message could not be decoded.'));
  }

  initialize(source: Uint8ClampedArray, width: number, height: number) {
    const workerSource = source.slice();
    const message: AdjustmentWorkerInitMessage = {
      type: 'init',
      assetGeneration: this.assetGeneration,
      sourceBuffer: workerSource.buffer,
      width,
      height,
    };
    this.worker.postMessage(message, [message.sourceBuffer]);
  }

  render(recipe: EditRecipe) {
    if (this.disposed || this.failed) return;
    if (this.inFlight) {
      this.pendingLatest = recipe;
      return;
    }
    this.send(recipe);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingLatest = null;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    if (!this.failed) this.worker.terminate();
  }

  private send(recipe: EditRecipe) {
    const requestId = this.nextRequestId++;
    const message: AdjustmentWorkerRenderMessage = {
      type: 'render',
      requestId,
      assetGeneration: this.assetGeneration,
      recipe,
    };
    this.inFlight = { requestId, assetGeneration: this.assetGeneration };
    try {
      this.worker.postMessage(message, []);
    } catch (error) {
      this.inFlight = null;
      this.fail(error instanceof Error ? error : new Error('Adjustment worker request failed.'));
    }
  }

  private receive(response: AdjustmentWorkerResponse) {
    if (this.disposed || this.failed || response.assetGeneration !== this.assetGeneration) return;
    if (response.type === 'ready') return;
    if (response.type === 'error') {
      if (response.requestId === undefined || response.requestId === this.inFlight?.requestId) {
        this.fail(new Error(response.message));
      }
      return;
    }

    const current = this.inFlight;
    if (!current || response.requestId !== current.requestId || response.assetGeneration !== current.assetGeneration) return;
    this.inFlight = null;
    const pending = this.pendingLatest;
    this.pendingLatest = null;
    if (pending) {
      this.send(pending);
      return;
    }
    this.callbacks.onResult(response);
  }

  private fail(error: Error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.pendingLatest = null;
    this.worker.terminate();
    this.callbacks.onError(error);
  }
}
