import { useEffect, useState } from 'react';
import { getAssetEditStatuses, getRawAssetEditStatuses } from './editStateApi';
import type { AssetEditStatuses } from './editStatus';

export type EditStatusesSnapshot = { statuses: AssetEditStatuses; state: 'loading' | 'ready' | 'partial' | 'error' };

export function useEditStatusesSnapshot(assetIds: string[], rawAssetIds: string[] = [], refresh = 0, knownRawAssetIds: string[] = []): EditStatusesSnapshot {
  const key = JSON.stringify([assetIds, rawAssetIds, knownRawAssetIds]);
  const [result, setResult] = useState<{ key: string; refresh: number; snapshot: EditStatusesSnapshot } | null>(null);
  useEffect(() => {
    const [ids, rawIds, knownRawIds] = JSON.parse(key) as [string[], string[], string[]];
    if (ids.length === 0 && rawIds.length === 0) { setResult({ key, refresh, snapshot: { statuses: {}, state: 'ready' } }); return; }
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    let timeout = 0;
    const batches: { ids: string[]; raw: boolean }[] = [];
    for (let index = 0; index < ids.length; index += 100) batches.push({ ids: ids.slice(index, index + 100), raw: false });
    for (let index = 0; index < rawIds.length; index += 100) batches.push({ ids: rawIds.slice(index, index + 100), raw: true });
    const values = new Array<AssetEditStatuses | null>(batches.length).fill(null);
    const requests = batches.map((batch, index) => (batch.raw ? getRawAssetEditStatuses : getAssetEditStatuses)(batch.ids, controller.signal)
      .catch(() => null).then(value => {
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
      const statuses: AssetEditStatuses = {};
      batches.forEach((batch, index) => {
        const value = values[index];
        if (!batch.raw && value) Object.assign(statuses, value);
        else if (batch.raw && value) {
          // Known RAW uses its own saved state even when a legacy JPEG-preview Recipe remains.
          for (const id of batch.ids) if (knownRawIds.includes(id) || value[id] !== false || !Object.hasOwn(statuses, id)) statuses[id] = value[id];
        }
      });
      const rawPending = batches.some((batch, index) => batch.raw && values[index] === null);
      batches.forEach((batch, index) => {
        if (batch.raw && values[index] === null) batch.ids.forEach(id => { statuses[id] = undefined; });
      });
      const state = successful.length === 0 ? 'error'
        : timedOut || successful.length < batches.length || rawPending ? 'partial' : 'ready';
      setResult({ key, refresh, snapshot: { statuses, state } });
    }).catch(() => { window.clearTimeout(timeout); });
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, refresh]);
  return result?.key === key && result.refresh === refresh ? result.snapshot : { statuses: {}, state: 'loading' };
}

export function useEditStatuses(assetIds: string[], rawAssetIds: string[] = [], refresh = 0, knownRawAssetIds: string[] = []): AssetEditStatuses {
  return useEditStatusesSnapshot(assetIds, rawAssetIds, refresh, knownRawAssetIds).statuses;
}
