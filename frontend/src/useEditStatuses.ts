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
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    void Promise.all(batches.map(batch => getAssetEditStatuses(batch, controller.signal).catch(() => null))).then(results => {
      if (!active || controller.signal.aborted) return;
      const successful = results.filter((result): result is AssetEditStatuses => result !== null);
      const statuses = Object.assign({}, ...successful);
      // Preserve partial successes while keeping unknown members distinguishable from a complete snapshot.
      const state = successful.length === 0 ? 'error' : successful.length < results.length ? 'partial' : 'ready';
      setResult({ key, refresh, snapshot: { statuses, state } });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, refresh]);
  return result?.key === key && result.refresh === refresh ? result.snapshot : { statuses: {}, state: 'loading' };
}

export function useEditStatuses(assetIds: string[], refresh = 0): AssetEditStatuses {
  return useEditStatusesSnapshot(assetIds, refresh).statuses;
}
