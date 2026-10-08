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
  const currentCard = selections.currentCard(asset);
  const manual = selections.getManualSelection(currentCard.stackId!);
  const selection = selectGalleryAssetTargets(currentCard, settings.anshitsuInitialSelection, manual);
  const candidates = selectGalleryAssetTargets(currentCard, 'both');
  const formatSource = currentCard.stackFormats?.length ? currentCard.stackFormats : formats;
  const uniqueFormats = formatSource.filter((format, index) => formatSource.findIndex(candidate =>
    candidate.format === format.format && candidate.isRaw === format.isRaw) === index);
  const coverFormatIndex = uniqueFormats.findIndex(format => format.format === currentCard.format && format.isRaw === currentCard.is_raw);
  const currentFormats = coverFormatIndex > 0
    ? [uniqueFormats[coverFormatIndex], ...uniqueFormats.slice(0, coverFormatIndex), ...uniqueFormats.slice(coverFormatIndex + 1)]
    : uniqueFormats;

  // Reconcile persistence after rendering; notifying shared subscribers during render is unsafe.
  useEffect(() => { selections.resolve(currentCard, settings.anshitsuInitialSelection); },
    [currentCard, settings.anshitsuInitialSelection, manual, selections.resolve]);

  return <div className="stack-format-badges">
    {currentFormats.map(({ format, isRaw }) => {
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
          const latestCard = selections.currentCard(asset);
          const latest = selections.resolve(latestCard, settings.anshitsuInitialSelection);
          const latestCandidates = selectGalleryAssetTargets(latestCard, 'both');
          const latestMembers = latestCandidates.assets?.filter(member => member.format === format && member.is_raw === isRaw) ?? [];
          if (latest.status !== 'ready' || latestMembers.length === 0) return;
          const ids = new Set(latest.selectedAssetIds);
          const on = latestMembers.some(member => ids.has(member.id.toLowerCase()));
          for (const member of latestMembers) {
            if (on) ids.delete(member.id.toLowerCase());
            else ids.add(member.id.toLowerCase());
          }
          selections.setManualSelection(latestCard, ids);
        }}>{format}</button>;
    })}
  </div>;
}
