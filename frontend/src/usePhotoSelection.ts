import { useCallback, useRef, useState } from 'react';
import { addVisiblePhotoRange, toggleSelectedAssetId } from './photoSelection';

export function usePhotoSelection() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const anchorId = useRef<string | null>(null);

  function toggle(assetId: string, visibleIds: string[], extendRange = false) {
    const rangedSelection = extendRange
      ? addVisiblePhotoRange(selectedIds, visibleIds, anchorId.current, assetId)
      : null;
    if (rangedSelection) {
      setSelectedIds(rangedSelection);
      return;
    }
    const nextSelection = toggleSelectedAssetId(selectedIds, assetId);
    anchorId.current = nextSelection.length > 0 ? assetId : null;
    setSelectedIds(nextSelection);
  }

  const clear = useCallback(() => {
    anchorId.current = null;
    setSelectedIds([]);
  }, []);

  function selectVisible(visibleIds: string[]) {
    // Keep the range anchor and hidden selections; bulk selection only appends new visible IDs.
    if (!anchorId.current && visibleIds.length > 0) anchorId.current = visibleIds[0];
    setSelectedIds(current => Array.from(new Set([...current, ...visibleIds])));
  }

  const retainAvailable = useCallback((availableIds: Set<string>) => {
    setSelectedIds(current => current.filter(id => availableIds.has(id)));
    if (anchorId.current && !availableIds.has(anchorId.current)) anchorId.current = null;
  }, []);

  return { selectedIds, toggle, selectVisible, clear, retainAvailable };
}
