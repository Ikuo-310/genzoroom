import { useAppSettings } from './appSettings';
import { useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FormatBadge } from './FormatBadge';
import { EditedBadge } from './EditedBadge';
import type { ExportQueueStatus } from './exportQueueApi';
import { formatPhotoDate, type AppLanguage } from './i18n';
import { isPrimaryModifier } from './shortcutModifiers';

export type { RecentAsset } from './assets';

function stackFormatList(asset: RecentAsset) {
  const formats = asset.stackFormats?.length ? asset.stackFormats : [{ format: asset.format, isRaw: asset.is_raw }];
  const unique = formats.filter((format, index) => formats.findIndex(candidate =>
    candidate.format === format.format && candidate.isRaw === format.isRaw) === index);
  const coverIndex = unique.findIndex(format => format.format === asset.format && format.isRaw === asset.is_raw);
  return coverIndex > 0 ? [unique[coverIndex], ...unique.slice(0, coverIndex), ...unique.slice(coverIndex + 1)] : unique;
}

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
  onSelect: () => void;
  onToggleSelection: () => void;
  onExtendSelection: () => void;
  onPreviewRequest?: () => void;
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
  onSelect,
  onToggleSelection,
  onExtendSelection,
  onPreviewRequest,
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
      onExtendSelection();
      return;
    }
    if (isPrimaryModifier(event.nativeEvent)) onToggleSelection();
    else onSelect();
  }

  function handleCheckboxClick(event: ReactMouseEvent<HTMLInputElement>) {
    rangeClickHandled.current = event.shiftKey;
    if (!event.shiftKey) return;
    // Prevent native checkbox activation so a follow-up change event cannot toggle the range endpoint twice.
    event.preventDefault();
    onExtendSelection();
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
        onDoubleClick={onPreviewRequest}
        aria-label={selectionLabel}
        aria-pressed={selected}
        aria-description={edited ? t('photos.edited') : undefined}
      >
        <div className="thumbnail">
          <img src={asset.thumbnail_url} alt="" loading="lazy" />
          {asset.stackId && Number.isSafeInteger(asset.stackAssetCount) && asset.stackAssetCount! >= 1 ? (
            <div className="stack-assets" role="img" aria-label={t(asset.stackAssetCount === 1 ? 'photos.invalidStack' : 'photos.stackAssets', { count: asset.stackAssetCount })}>
              <div className="stack-format-badges">
                {stackFormatList(asset).map(({ format, isRaw }, index) =>
                  <FormatBadge key={`${format}:${isRaw}:${index}`} format={format} isRaw={isRaw} />)}
              </div>
              <span className={`stack-asset-count${asset.stackAssetCount === 1 ? ' stack-asset-count-error' : ''}`}>{asset.stackAssetCount}</span>
            </div>
          ) : <div className="photo-format-badges"><FormatBadge format={asset.format} isRaw={asset.is_raw} /></div>}
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
