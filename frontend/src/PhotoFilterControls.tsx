import { useTranslation } from 'react-i18next';
import type { PhotoFilterMode, PhotoFilters } from './photoFilters';

type PhotoFilterControlsProps = {
  filters: PhotoFilters;
  onChange: (filter: PhotoFilterMode) => void;
};

export function PhotoFilterControls({ filters, onChange }: PhotoFilterControlsProps) {
  const { t } = useTranslation();
  const value = filters.raw ? filters.nonRaw ? 'both' : 'raw' : 'nonRaw';

  return (
    <label className="home-control photo-filter-control">
      <span className="home-control-label">{t('photos.filterLabel')}</span>
      <select aria-label={t('photos.filterLabel')} value={value}
        onChange={event => onChange(event.target.value as PhotoFilterMode)}>
        <option value="both">{t('photos.allTypes')}</option>
        <option value="raw">{t('photos.rawOnly')}</option>
        <option value="nonRaw">{t('photos.nonRaw')}</option>
      </select>
    </label>
  );
}
