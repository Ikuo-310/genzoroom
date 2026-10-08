import { useEffect, useState } from 'react';
import { getAssetEditStatuses } from './editStateApi';
import type { AssetEditStatuses } from './editStatus';

export type EditStatusesSnapshot = { statuses: AssetEditStatuses; state: 'loading' | 'ready' | 'partial' | 'error' };

export function useEditStatusesSnapshot(assetIds: string[], refresh = 0): EditStatusesSnapshot {
  const key = JSON.stringify(assetIds);
  const [result, setResult] = useState<{ key: string; refresh: number; snapshot: EditStatusesSnapshot } | null>(null);
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    if (ids.length === 0) { setResult({ key, refresh, snapshot: { statuses: {}, state: 'ready' } }); return; }
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    let timeout = 0;
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    const values = new Array<AssetEditStatuses | null>(batches.length).fill(null);
    const requests = batches.map((batch, index) => getAssetEditStatuses(batch, controller.signal).catch(() => null).then(value => {
      if (active && !timedOut) values[index] = value;
      return value;
    }));
    const timeoutResult = new Promise<void>(resolve => {
      timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve();
      }, 8000);
    });
    void Promise.race([Promise.all(requests), timeoutResult]).then(() => {
      window.clearTimeout(timeout);
      if (!active) return;
      // A live timeout must settle visible state, while cleanup aborts are still ignored as stale work.
      const successful = values.filter((value): value is AssetEditStatuses => value !== null);
      const state = successful.length === 0 ? 'error'
        : timedOut || successful.length < batches.length ? 'partial' : 'ready';
      setResult({ key, refresh, snapshot: { statuses: Object.assign({}, ...successful), state } });
    }).catch(() => { window.clearTimeout(timeout); });
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, refresh]);
  return result?.key === key && result.refresh === refresh ? result.snapshot : { statuses: {}, state: 'loading' };
}

export function useEditStatuses(assetIds: string[], refresh = 0): AssetEditStatuses {
  return useEditStatusesSnapshot(assetIds, refresh).statuses;
}
