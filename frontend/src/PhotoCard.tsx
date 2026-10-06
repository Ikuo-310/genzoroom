import { useAppSettings } from './appSettings';
import { useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FormatBadge } from './FormatBadge';
import { EditedBadge } from './EditedBadge';
import type { ExportQueueStatus } from './exportQueueApi';
import { formatPhotoDate, type AppLanguage } from './i18n';

export type { RecentAsset } from './assets';

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
  onOpen: () => void;
  onToggleSelection: (extendRange?: boolean) => void;
  selected?: boolean;
  selectionMode?: boolean;
  edited?: boolean;
  queueKnown?: boolean;
  queueStatus?: ExportQueueStatus;
  queueBusy?: boolean;
  onQueueToggle?: () => void;
};

export function PhotoCard({
  asset,
  language,
  onOpen,
  onToggleSelection,
  selected = false,
  selectionMode = false,
  edited,
  queueKnown,
  queueStatus,
  queueBusy,
  onQueueToggle,
}: PhotoCardProps) {
  useAppSettings();
  const { t } = useTranslation();
  const rangeClickHandled = useRef(false);
  const selectionLabel = t(selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename });

  function handleCardClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (event.shiftKey) {
      onToggleSelection(true);
      return;
    }
    // Once selection mode starts, the card surface toggles selection instead of navigating.
    if (selectionMode) onToggleSelection();
    else onOpen();
  }

  function handleCheckboxClick(event: ReactMouseEvent<HTMLInputElement>) {
    rangeClickHandled.current = event.shiftKey;
    if (!event.shiftKey) return;
    // Prevent native checkbox activation so a follow-up change event cannot toggle the range endpoint twice.
    event.preventDefault();
    onToggleSelection(true);
  }

  function handleCheckboxChange() {
    if (rangeClickHandled.current) {
      rangeClickHandled.current = false;
      return;
    }
    onToggleSelection();
  }

  return (
    <article className={`photo-card${selected ? ' selected' : ''}${selectionMode ? ' selection-mode' : ''}`}>
      <label className="photo-selection-control" title={selectionLabel}>
        <input
          className="photo-selection-input"
          type="checkbox"
          checked={selected}
          onClick={handleCheckboxClick}
          onChange={handleCheckboxChange}
          aria-label={selectionLabel}
        />
      </label>
      <button
        className="photo-card-button"
        type="button"
        onClick={handleCardClick}
        aria-label={selectionMode ? selectionLabel : t('photos.openWorkspace', { filename: asset.filename })}
        aria-pressed={selectionMode ? selected : undefined}
        aria-description={edited ? t('photos.edited') : undefined}
      >
        <div className="thumbnail">
          <img src={asset.thumbnail_url} alt="" loading="lazy" />
          <FormatBadge format={asset.format} isRaw={asset.is_raw} />
          {asset.stackId && Number.isSafeInteger(asset.stackAssetCount) && asset.stackAssetCount! >= 1 && (
            <div className="stack-assets" role="img" aria-label={t(asset.stackAssetCount === 1 ? 'photos.invalidStack' : 'photos.stackAssets', { count: asset.stackAssetCount })}>
              <span className={`stack-asset-count${asset.stackAssetCount === 1 ? ' stack-asset-count-error' : ''}`}>{asset.stackAssetCount}</span>
            </div>
          )}
        </div>
        <div className="photo-info">
          <p title={asset.filename}>{asset.filename}</p>
          <time dateTime={asset.date}>{formatPhotoDate(asset.date)}</time>
        </div>
      </button>
      <div className="photo-card-badges">
        <EditedBadge edited={edited} queueKnown={queueKnown} queueStatus={queueStatus}
          busy={queueBusy} onQueueToggle={onQueueToggle} showQueueShortcut={false} />
      </div>
    </article>
  );
}
