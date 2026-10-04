import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSelectedImmichStacks, ImmichStacksError, refreshSelectedImmichStacks } from './api';
import type { ImmichStack, RecentAsset } from './assets';
import { frontendLogger } from './frontendLogging';

const EMPTY_STACKS: ImmichStack[] = [];

type ResolveMode = 'resolve' | 'refresh';
function logSafely(level: 'warn' | 'error' | 'debug', event: string, context: Record<string, string | number | boolean | string[]>) {
  try { frontendLogger.add({ level, component: 'stack_resolve', event, context }); }
  catch { /* Diagnostics must not change Stack resolution outcomes. */ }
}

function logMismatch(context: Record<string, string | number | boolean | string[]>, memberIds: string[] = []) {
  const chunkSize = 32;
  const chunkCount = Math.max(1, Math.ceil(memberIds.length / chunkSize));
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    const returnedMemberIds = memberIds.slice(chunk * chunkSize, (chunk + 1) * chunkSize);
    logSafely('warn', 'validation.mismatch', { ...context, returnedMemberIds,
      ...(chunkCount > 1 ? { memberIdsOffset: chunk * chunkSize, memberIdsChunkCount: chunkCount } : {}) });
  }
}

function errorCode(error: unknown): string {
  return error instanceof ImmichStacksError ? error.code : 'operation_failed';
}

function logApiMismatch(error: ImmichStacksError, assets: readonly RecentAsset[], generation: number, mode: ResolveMode, requestedStackCount: number) {
  const base = { generation, mode, selectedAssetCount: assets.length, requestedStackCount, errorCode: error.code };
  if (error.code === 'singleton_stack' && error.details.stackId) {
    const memberIds = error.details.memberIds ?? [];
    const matching = assets.filter(asset => asset.stackId?.toLowerCase() === error.details.stackId);
    for (const asset of matching) logMismatch({ ...base, selectedAssetId: asset.id,
      expectedStackId: error.details.stackId, returnedStackFound: true, returnedStackId: error.details.stackId,
      ...(error.details.primaryAssetId ? { returnedPrimaryAssetId: error.details.primaryAssetId } : {}),
      returnedMemberCount: error.details.memberCount ?? memberIds.length,
      selectedAssetPresent: memberIds.includes(asset.id.toLowerCase()) }, memberIds);
    return;
  }
  if (error.code === 'requested_stack_missing') {
    for (const stackId of error.details.missingStackIds ?? []) {
      const matching = assets.filter(asset => asset.stackId?.toLowerCase() === stackId);
      for (const asset of matching) logMismatch({ ...base, selectedAssetId: asset.id, expectedStackId: stackId,
        returnedStackFound: false, returnedMemberCount: 0, selectedAssetPresent: false });
    }
    return;
  }
  logMismatch({ ...base, ...(error.details.stackId ? { returnedStackId: error.details.stackId } : {}),
    ...(error.details.httpStatus === undefined ? {} : { httpStatus: error.details.httpStatus }) });
}

export function useSelectedImmichStacks(assets: readonly RecentAsset[]) {
  const stackIds = useMemo(() => [...new Set(assets.flatMap(asset => asset.stackId == null ? [] : [asset.stackId.toLowerCase()]))], [assets]);
  const [state, setState] = useState<{ assets: readonly RecentAsset[]; stacks: ImmichStack[]; loading: boolean; error: boolean; refreshed: boolean } | null>(null);
  const request = useRef({ generation: 0, controller: null as AbortController | null, busy: false });
  const resolve = useCallback((refresh = false) => {
    request.current.controller?.abort();
    const generation = ++request.current.generation;
    const mode: ResolveMode = refresh ? 'refresh' : 'resolve';
    const controller = new AbortController();
    request.current.controller = controller;
    request.current.busy = refresh ? assets.length > 0 : stackIds.length > 0;
    setState({ assets, stacks: EMPTY_STACKS, loading: request.current.busy, error: false, refreshed: refresh });
    if (!request.current.busy) return;
    logSafely('debug', 'resolve.start', { generation, mode, selectedAssetCount: assets.length, requestedStackCount: stackIds.length });
    const isCurrent = () => !controller.signal.aborted && request.current.generation === generation;
    void (refresh ? refreshSelectedImmichStacks(assets.map(asset => asset.id), controller.signal) : fetchSelectedImmichStacks(stackIds, controller.signal)).then(stacks => {
      if (!isCurrent()) return;
      const lookup = new Map(stacks.map(stack => [stack.id.toLowerCase(), stack]));
      // Stale Home metadata cannot establish full membership or authorize editing a partial Stack.
      if (!refresh) {
        let mismatchFound = false;
        for (const asset of assets) {
          if (asset.stackId == null) continue;
          const expectedStackId = asset.stackId.toLowerCase();
          const returned = lookup.get(expectedStackId);
          const memberIds = returned?.assets.map(member => member.id.toLowerCase()) ?? [];
          const selectedAssetPresent = memberIds.includes(asset.id.toLowerCase());
          if (selectedAssetPresent) continue;
          mismatchFound = true;
          logMismatch({ generation, mode, selectedAssetCount: assets.length, requestedStackCount: stackIds.length,
            selectedAssetId: asset.id, expectedStackId, returnedStackFound: returned !== undefined,
            ...(returned ? { returnedStackId: returned.id, returnedPrimaryAssetId: returned.primaryAssetId } : {}),
            returnedMemberCount: memberIds.length, selectedAssetPresent }, memberIds);
        }
        if (mismatchFound) throw new ImmichStacksError('selected_member_missing');
      }
      logSafely('debug', 'resolve.success', { generation, mode, returnedStackCount: stacks.length,
        memberCount: stacks.reduce((count, stack) => count + stack.assets.length, 0) });
      setState({ assets, stacks: refresh ? stacks : stackIds.map(id => lookup.get(id)!), loading: false, error: false, refreshed: refresh });
      request.current.busy = false;
    }).catch(error => {
      if (!isCurrent()) return;
      if (error instanceof ImmichStacksError && error.code !== 'selected_member_missing' && error.code !== 'request_failed') {
        logApiMismatch(error, assets, generation, mode, stackIds.length);
      }
      logSafely('error', 'operation.failed', { generation, mode, errorCode: errorCode(error),
        selectedAssetCount: assets.length, requestedStackCount: stackIds.length,
        ...(error instanceof ImmichStacksError && error.details.httpStatus !== undefined ? { httpStatus: error.details.httpStatus } : {}) });
      setState({ assets, stacks: EMPTY_STACKS, loading: false, error: true, refreshed: refresh });
      request.current.busy = false;
    });
  }, [assets, stackIds]);
  useEffect(() => {
    resolve();
    return () => { request.current.controller?.abort(); request.current.generation++; request.current.busy = false; };
  }, [resolve]);
  const retry = (refresh = false) => { if (!request.current.busy) resolve(refresh); };
  return state?.assets === assets ? { ...state, retry }
    : { stacks: EMPTY_STACKS, loading: stackIds.length > 0, error: false, refreshed: false, retry };
}
