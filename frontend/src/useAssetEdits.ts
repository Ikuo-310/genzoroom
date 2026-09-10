import { useCallback, useEffect, useState } from 'react';
import { editAsset, newSession, type EditAction, type EditSession } from './editing';
import { isNativeEditingTarget, undoShortcut } from './editShortcuts';

export function useAssetEdits(assetId: string, enabled: boolean) {
  const [sessions, setSessions] = useState<Record<string, EditSession>>({});
  const dispatch = useCallback((action: EditAction) => {
    setSessions((current) => editAsset(current, assetId, action));
  }, [assetId]);
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isNativeEditingTarget(event.target)) return;
      const type = undoShortcut(event);
      if (!type) return;
      event.preventDefault();
      dispatch({ type });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dispatch, enabled]);
  // Commit an unfinished gesture to its original asset, including route changes.
  useEffect(() => () => dispatch({ type: 'commit' }), [dispatch]);
  return { session: sessions[assetId] ?? newSession(), dispatch };
}
