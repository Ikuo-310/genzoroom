import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { useAppSettings } from './appSettings';
import { selectGalleryAssetTargets } from './galleryAssetSelection';
import { useGalleryStackSelections } from './useGalleryStackSelections';

export function StackFormatSwitches({ asset, formats }: {
  asset: RecentAsset;
  formats: readonly { format: string; isRaw: boolean }[];
}) {
  const settings = useAppSettings();
  const selections = useGalleryStackSelections();
  const { t } = useTranslation();
  const manual = selections.getManualSelection(asset.stackId!);
  const selection = selectGalleryAssetTargets(asset, settings.anshitsuInitialSelection, manual);
  const candidates = selectGalleryAssetTargets(asset, 'both');

  // Reconcile persistence after rendering; notifying shared subscribers during render is unsafe.
  useEffect(() => { selections.resolve(asset, settings.anshitsuInitialSelection); },
    [asset, settings.anshitsuInitialSelection, manual, selections.resolve]);

  return <div className="stack-format-badges">
    {formats.map(({ format, isRaw }) => {
      const members = candidates.assets?.filter(member => member.format === format && member.is_raw === isRaw) ?? [];
      const pressed = members.some(member => selection.selectedAssetIds.has(member.id.toLowerCase()));
      const unavailable = selection.status === 'unavailable';
      return <button key={`${format}:${isRaw}`} type="button"
        className={`format-badge stack-format-switch${isRaw ? ' raw' : ''}`}
        aria-pressed={unavailable ? undefined : pressed}
        data-state={unavailable ? 'unavailable' : pressed ? 'on' : 'off'}
        title={unavailable ? t('photos.workspaceUnavailable') : undefined}
        disabled={unavailable || members.length === 0}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          // Resolve again at activation so a shared change cannot be overwritten by a stale render.
          const latest = selections.resolve(asset, settings.anshitsuInitialSelection);
          if (latest.status !== 'ready' || members.length === 0) return;
          const ids = new Set(latest.selectedAssetIds);
          const on = members.some(member => ids.has(member.id.toLowerCase()));
          for (const member of members) {
            if (on) ids.delete(member.id.toLowerCase());
            else ids.add(member.id.toLowerCase());
          }
          selections.setManualSelection(asset, ids);
        }}>{format}</button>;
    })}
  </div>;
}
