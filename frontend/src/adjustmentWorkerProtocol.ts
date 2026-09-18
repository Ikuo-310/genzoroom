import type { EditRecipe } from './editing';

export type AdjustmentWorkerInitMessage = {
  type: 'init';
  assetGeneration: number;
  sourceBuffer: ArrayBuffer;
  width: number;
  height: number;
};

export type AdjustmentWorkerRenderMessage = {
  type: 'render';
  requestId: number;
  assetGeneration: number;
  recipe: EditRecipe;
};

export type AdjustmentWorkerRequest = AdjustmentWorkerInitMessage | AdjustmentWorkerRenderMessage;

export type AdjustmentWorkerReadyMessage = {
  type: 'ready';
  assetGeneration: number;
};

export type AdjustmentWorkerResultMessage = {
  type: 'result';
  requestId: number;
  assetGeneration: number;
  pixelBuffer: ArrayBuffer;
  width: number;
  height: number;
};

export type AdjustmentWorkerErrorMessage = {
  type: 'error';
  requestId?: number;
  assetGeneration: number;
  message: string;
};

export type AdjustmentWorkerResponse = AdjustmentWorkerReadyMessage | AdjustmentWorkerResultMessage | AdjustmentWorkerErrorMessage;
