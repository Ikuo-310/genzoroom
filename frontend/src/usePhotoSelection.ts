import { useCallback, useRef, useState } from 'react';
import { addVisiblePhotoRange, selectOnlyAssetId, toggleSelectedAssetId } from './photoSelection';

export function usePhotoSelection() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedIdsRef = useRef(selectedIds);
  const anchorId = useRef<string | null>(null);

  function updateSelection(nextSelection: string[]) {
    // Keep back-to-back actions coherent before React commits the next render.
    selectedIdsRef.current = nextSelection;
    setSelectedIds(nextSelection);
  }

  function selectOnly(assetId: string) {
    anchorId.current = assetId;
    updateSelection(selectOnlyAssetId(assetId));
  }

  function toggle(assetId: string) {
    const nextSelection = toggleSelectedAssetId(selectedIdsRef.current, assetId);
    anchorId.current = nextSelection.length > 0 ? assetId : null;
    updateSelection(nextSelection);
  }

  function extendRange(assetId: string, visibleIds: string[]) {
    const rangedSelection = addVisiblePhotoRange(selectedIdsRef.current, visibleIds, anchorId.current, assetId);
    if (rangedSelection) updateSelection(rangedSelection);
  }

  const clear = useCallback(() => {
    anchorId.current = null;
    updateSelection([]);
  }, []);

  function selectVisible(visibleIds: string[]) {
    // Keep the range anchor and hidden selections; bulk selection only appends new visible IDs.
    if (!anchorId.current && visibleIds.length > 0) anchorId.current = visibleIds[0];
    updateSelection(Array.from(new Set([...selectedIdsRef.current, ...visibleIds])));
  }

  const retainAvailable = useCallback((availableIds: Set<string>) => {
    updateSelection(selectedIdsRef.current.filter(id => availableIds.has(id)));
    if (anchorId.current && !availableIds.has(anchorId.current)) anchorId.current = null;
  }, []);

  return { selectedIds, selectOnly, toggle, extendRange, selectVisible, clear, retainAvailable };
}
