import { describe, expect, it, vi } from 'vitest';
import { AdjustmentWorkerClient, type AdjustmentWorkerLike } from './adjustmentWorkerClient';
import { defaultRecipe, type EditRecipe } from './editing';
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse, AdjustmentWorkerResultMessage } from './adjustmentWorkerProtocol';

class FakeWorker implements AdjustmentWorkerLike {
  onmessage: ((event: MessageEvent<AdjustmentWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: Array<{ message: AdjustmentWorkerRequest; transfer: Transferable[] }> = [];
  terminate = vi.fn();

  postMessage(message: AdjustmentWorkerRequest, transfer: Transferable[]) {
    this.sent.push({ message, transfer });
  }

  emit(response: AdjustmentWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<AdjustmentWorkerResponse>);
  }
}

function withExposure(value: number): EditRecipe {
  const recipe = defaultRecipe();
  recipe.adjustments.exposure = value;
  return recipe;
}

function result(requestId: number, assetGeneration = 12): AdjustmentWorkerResultMessage {
  return { type: 'result', requestId, assetGeneration, pixelBuffer: new ArrayBuffer(4), width: 1, height: 1 };
}

describe('AdjustmentWorkerClient', () => {
  it('transfers a one-time source copy and sends render identity fields', () => {
    const worker = new FakeWorker();
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const client = new AdjustmentWorkerClient(worker, 12, { onResult: vi.fn(), onError: vi.fn() });
    client.initialize(source, 1, 1);
    client.render(withExposure(1));

    const init = worker.sent[0];
    expect(init.message.type).toBe('init');
    if (init.message.type !== 'init') throw new Error('Expected init');
    expect(init.message.assetGeneration).toBe(12);
    expect(new Uint8ClampedArray(init.message.sourceBuffer)).toEqual(source);
    expect(init.message.sourceBuffer).not.toBe(source.buffer);
    expect(init.transfer).toEqual([init.message.sourceBuffer]);
    expect(source).toEqual(new Uint8ClampedArray([1, 2, 3, 4]));

    expect(worker.sent[1]).toMatchObject({
      message: { type: 'render', requestId: 1, assetGeneration: 12, recipe: withExposure(1) },
      transfer: [],
    });
  });

  it('keeps at most one in-flight render plus only the latest pending recipe', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new AdjustmentWorkerClient(worker, 12, { onResult, onError: vi.fn() });
    client.render(withExposure(1));
    client.render(withExposure(2));
    client.render(withExposure(3));
    const latest = withExposure(4);
    latest.adjustments.shadowsTint = 60;
    latest.gradingShadowsEnabled = false;
    client.render(latest);
    expect(worker.sent).toHaveLength(1);

    worker.emit(result(1));
    expect(onResult).not.toHaveBeenCalled();
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({
      message: { type: 'render', requestId: 2, assetGeneration: 12, recipe: latest },
    });

    worker.emit(result(2));
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ requestId: 2, assetGeneration: 12 }));
  });

  it('ignores stale request and asset generation results', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new AdjustmentWorkerClient(worker, 12, { onResult, onError: vi.fn() });
    client.render(withExposure(1));
    worker.emit(result(99));
    worker.emit(result(1, 11));
    expect(onResult).not.toHaveBeenCalled();
    worker.emit(result(1));
    expect(onResult).toHaveBeenCalledOnce();
  });

  it('terminates and reports runtime and message errors once', () => {
    const worker = new FakeWorker();
    const onError = vi.fn();
    const client = new AdjustmentWorkerClient(worker, 12, { onResult: vi.fn(), onError });
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    worker.onmessageerror?.({} as MessageEvent<unknown>);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('boom');
    client.render(withExposure(2));
    expect(worker.sent).toHaveLength(0);
  });

  it('falls back when posting a render request fails', () => {
    const worker = new FakeWorker();
    const onError = vi.fn();
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => { throw new Error('clone failed'); });
    const client = new AdjustmentWorkerClient(worker, 12, { onResult: vi.fn(), onError });
    client.render(withExposure(1));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'clone failed' }));
  });

  it('stops all callbacks and work after cleanup', () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new AdjustmentWorkerClient(worker, 12, { onResult, onError: vi.fn() });
    client.render(withExposure(1));
    const handler = worker.onmessage;
    client.dispose();
    handler?.({ data: result(1) } as MessageEvent<AdjustmentWorkerResponse>);
    client.render(withExposure(2));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(worker.sent).toHaveLength(1);
  });
});
