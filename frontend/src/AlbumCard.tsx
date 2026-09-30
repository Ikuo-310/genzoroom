import { useTranslation } from 'react-i18next';
import { resolveDateLocaleForLanguage, useAppSettings } from './appSettings';
import type { AlbumSummary } from './albums';
import { formatAlbumMonth } from './albums';

export function AlbumCard({ album }: { album: AlbumSummary }) {
  const { t, i18n } = useTranslation();
  const { dateLocale } = useAppSettings();
  const locale = resolveDateLocaleForLanguage(dateLocale, i18n.resolvedLanguage === 'ja' ? 'ja' : 'en');
  const start = formatAlbumMonth(album.startDate, locale);
  const end = formatAlbumMonth(album.endDate, locale);
  const period = start && end && start !== end ? t('albums.dateRange', { start, end }) : start || end;

  return <article className="album-card">
    <div className="album-cover">
      {album.albumThumbnailAssetId
        ? <img src={`/api/assets/${encodeURIComponent(album.albumThumbnailAssetId)}/thumbnail`} alt="" loading="lazy" />
        : <span className="album-cover-placeholder">{t('albums.noCover')}</span>}
    </div>
    <div className="album-info">
      <h3>{album.albumName}</h3>
      {period && <p className="album-period">{period}</p>}
      <p className="album-count">{t('albums.itemCount', { count: album.assetCount })}</p>
    </div>
  </article>;
}
