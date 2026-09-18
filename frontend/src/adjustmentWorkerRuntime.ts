import { renderAdjustments } from './adjustmentPipeline';
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from './adjustmentWorkerProtocol';

export type AdjustmentWorkerState = {
  assetGeneration: number;
  source: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
} | null;

export type AdjustmentWorkerPost = (response: AdjustmentWorkerResponse, transfer?: Transferable[]) => void;

export function handleAdjustmentWorkerMessage(
  state: AdjustmentWorkerState,
  message: AdjustmentWorkerRequest,
  post: AdjustmentWorkerPost,
): AdjustmentWorkerState {
  if (message.type === 'init') {
    const next = {
      assetGeneration: message.assetGeneration,
      source: new Uint8ClampedArray(message.sourceBuffer),
      width: message.width,
      height: message.height,
    };
    post({ type: 'ready', assetGeneration: message.assetGeneration });
    return next;
  }

  if (!state || state.assetGeneration !== message.assetGeneration) {
    post({
      type: 'error',
      requestId: message.requestId,
      assetGeneration: message.assetGeneration,
      message: 'Adjustment worker source is not initialized for this asset generation.',
    });
    return state;
  }

  try {
    const pixels = renderAdjustments(state.source, message.recipe);
    post({
      type: 'result',
      requestId: message.requestId,
      assetGeneration: message.assetGeneration,
      pixelBuffer: pixels.buffer,
      width: state.width,
      height: state.height,
    }, [pixels.buffer]);
  } catch (error) {
    post({
      type: 'error',
      requestId: message.requestId,
      assetGeneration: message.assetGeneration,
      message: error instanceof Error ? error.message : 'Adjustment worker render failed.',
    });
  }
  return state;
}
