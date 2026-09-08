import { useTranslation } from 'react-i18next';
import type { PhotoFilterKey, PhotoFilters } from './photoFilters';

type PhotoFilterControlsProps = {
  filters: PhotoFilters;
  onToggle: (filter: PhotoFilterKey) => void;
};

export function PhotoFilterControls({ filters, onToggle }: PhotoFilterControlsProps) {
  const { t } = useTranslation();

  return (
    <fieldset className="photo-filters">
      <legend>{t('photos.filterLabel')}</legend>
      <label className={`photo-filter${filters.raw ? ' selected' : ''}`}>
        <input
          type="checkbox"
          checked={filters.raw}
          disabled={filters.raw && !filters.nonRaw}
          onChange={() => onToggle('raw')}
        />
        RAW
      </label>
      <label className={`photo-filter${filters.nonRaw ? ' selected' : ''}`}>
        <input
          type="checkbox"
          checked={filters.nonRaw}
          disabled={filters.nonRaw && !filters.raw}
          onChange={() => onToggle('nonRaw')}
        />
        {t('photos.nonRaw')}
      </label>
    </fieldset>
  );
}
