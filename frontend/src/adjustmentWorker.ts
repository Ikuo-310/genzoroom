/// <reference lib="webworker" />
import { handleAdjustmentWorkerMessage, type AdjustmentWorkerState } from './adjustmentWorkerRuntime';
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from './adjustmentWorkerProtocol';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let state: AdjustmentWorkerState = null;

workerScope.onmessage = (event: MessageEvent<AdjustmentWorkerRequest>) => {
  state = handleAdjustmentWorkerMessage(state, event.data, (response: AdjustmentWorkerResponse, transfer = []) => {
    workerScope.postMessage(response, transfer);
  });
};

export {};
