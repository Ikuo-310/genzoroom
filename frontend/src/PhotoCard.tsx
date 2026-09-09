import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FormatBadge } from './FormatBadge';
import { formatPhotoDate, type AppLanguage } from './i18n';

export type { RecentAsset } from './assets';

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
  onOpen: () => void;
  onToggleSelection: () => void;
  selected?: boolean;
  selectionMode?: boolean;
};

export function PhotoCard({
  asset,
  language,
  onOpen,
  onToggleSelection,
  selected = false,
  selectionMode = false,
}: PhotoCardProps) {
  const { t } = useTranslation();
  const selectionLabel = t(selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename });

  function handleCardClick() {
    // Once selection mode starts, the card surface toggles selection instead of navigating.
    if (selectionMode) onToggleSelection();
    else onOpen();
  }

  return (
    <article className={`photo-card${selected ? ' selected' : ''}${selectionMode ? ' selection-mode' : ''}`}>
      <label className="photo-selection-control" title={selectionLabel}>
        <input
          className="photo-selection-input"
          type="checkbox"
          checked={selected}
          onChange={onToggleSelection}
          aria-label={selectionLabel}
        />
      </label>
      <button
        className="photo-card-button"
        type="button"
        onClick={handleCardClick}
        aria-label={selectionMode ? selectionLabel : t('photos.openWorkspace', { filename: asset.filename })}
        aria-pressed={selectionMode ? selected : undefined}
      >
        <div className="thumbnail">
          <img src={asset.thumbnail_url} alt="" loading="lazy" />
          <FormatBadge format={asset.format} isRaw={asset.is_raw} />
        </div>
        <div className="photo-info">
          <p title={asset.filename}>{asset.filename}</p>
          <time dateTime={asset.date}>{formatPhotoDate(asset.date, language)}</time>
        </div>
      </button>
    </article>
  );
}
