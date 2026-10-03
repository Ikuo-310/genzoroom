import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSelectedImmichStacks, refreshSelectedImmichStacks } from './api';
import type { ImmichStack, RecentAsset } from './assets';

const EMPTY_STACKS: ImmichStack[] = [];

export function useSelectedImmichStacks(assets: readonly RecentAsset[]) {
  const stackIds = useMemo(() => [...new Set(assets.flatMap(asset => asset.stackId == null ? [] : [asset.stackId.toLowerCase()]))], [assets]);
  const [state, setState] = useState<{ assets: readonly RecentAsset[]; stacks: ImmichStack[]; loading: boolean; error: boolean; refreshed: boolean } | null>(null);
  const request = useRef({ generation: 0, controller: null as AbortController | null, busy: false });
  const resolve = useCallback((refresh = false) => {
    request.current.controller?.abort();
    const generation = ++request.current.generation;
    const controller = new AbortController();
    request.current.controller = controller;
    request.current.busy = refresh ? assets.length > 0 : stackIds.length > 0;
    setState({ assets, stacks: EMPTY_STACKS, loading: request.current.busy, error: false, refreshed: refresh });
    if (!request.current.busy) return;
    const isCurrent = () => !controller.signal.aborted && request.current.generation === generation;
    void (refresh ? refreshSelectedImmichStacks(assets.map(asset => asset.id), controller.signal) : fetchSelectedImmichStacks(stackIds, controller.signal)).then(stacks => {
      if (!isCurrent()) return;
      const lookup = new Map(stacks.map(stack => [stack.id.toLowerCase(), stack]));
      // Stale Home metadata cannot establish full membership or authorize editing a partial Stack.
      if (!refresh && assets.some(asset => asset.stackId != null && !lookup.get(asset.stackId.toLowerCase())?.assets.some(member => member.id.toLowerCase() === asset.id.toLowerCase()))) {
        throw new Error('Selected Stack member is missing');
      }
      setState({ assets, stacks: refresh ? stacks : stackIds.map(id => lookup.get(id)!), loading: false, error: false, refreshed: refresh });
      request.current.busy = false;
    }).catch(() => {
      if (!isCurrent()) return;
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
