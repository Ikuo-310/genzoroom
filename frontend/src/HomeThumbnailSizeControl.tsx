import { useTranslation } from 'react-i18next';
import { updateSetting, useAppSettings, type HomeThumbnailColumns } from './appSettings';

export function HomeThumbnailSizeControl() {
  const { t } = useTranslation();
  const columns = useAppSettings().homeThumbnailColumns;
  const setColumns = (value: number) => updateSetting('homeThumbnailColumns', value as HomeThumbnailColumns);
  const rank = 8 - columns;
  return <div className="thumbnail-size-control" role="group" aria-label={t('photos.thumbnailSize')}>
    <button type="button" className="thumbnail-size-icon" aria-label={t('photos.smallerThumbnails')} title={t('photos.smallerThumbnails')}
      disabled={columns === 8} onClick={() => setColumns(columns + 1)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z" /></svg>
    </button>
    <input type="range" min="0" max="5" step="1" value={rank} aria-label={t('photos.thumbnailSize')}
      aria-valuetext={t('photos.thumbnailColumns', { count: columns })}
      onChange={event => setColumns(8 - Number(event.currentTarget.value))} />
    <button type="button" className="thumbnail-size-icon" aria-label={t('photos.largerThumbnails')} title={t('photos.largerThumbnails')}
      disabled={columns === 3} onClick={() => setColumns(columns - 1)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h14v14H3z" /></svg>
    </button>
    <span className="visually-hidden">{t('photos.thumbnailColumns', { count: columns })}</span>
  </div>;
}
