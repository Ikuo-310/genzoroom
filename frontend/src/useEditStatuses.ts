import { useEffect, useState } from 'react';
import { getAssetEditStatuses } from './editStateApi';
import type { AssetEditStatuses } from './editStatus';

export function useEditStatuses(assetIds: string[], refresh = 0): AssetEditStatuses {
  const key = JSON.stringify(assetIds);
  const [result, setResult] = useState<{ key: string; refresh: number; statuses: AssetEditStatuses } | null>(null);
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    if (ids.length === 0) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    void Promise.all(batches.map(batch => getAssetEditStatuses(batch, controller.signal).catch(() => null))).then(results => {
      if (!active || controller.signal.aborted) return;
      const statuses = Object.assign({}, ...results.filter((result): result is AssetEditStatuses => result !== null));
      // Successful batches remain useful when another batch fails; absent IDs stay unknown.
      setResult({ key, refresh, statuses });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, refresh]);
  return result?.key === key && result.refresh === refresh ? result.statuses : {};
}
