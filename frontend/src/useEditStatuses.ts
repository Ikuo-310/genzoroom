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
    void getAssetEditStatuses(ids, controller.signal).then(statuses => {
      if (active && !controller.signal.aborted) setResult({ key, refresh, statuses });
    }).catch(() => {
      // Unknown stays unknown; a failed request must not certify photos as unedited.
      if (active) setResult({ key, refresh, statuses: {} });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, refresh]);
  return result?.key === key && result.refresh === refresh ? result.statuses : {};
}
