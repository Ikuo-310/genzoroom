import { useTranslation } from 'react-i18next';
import type { AlbumSummary } from './albums';
import { formatAlbumMonth } from './albums';
import { ThumbnailImage } from './ThumbnailImage';

export function AlbumCard({ album, onOpen }: { album: AlbumSummary; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const compactJapanese = i18n.resolvedLanguage === 'ja';
  const start = formatAlbumMonth(album.startDate, undefined, compactJapanese);
  const end = formatAlbumMonth(album.endDate, undefined, compactJapanese);
  const period = start && end && start !== end ? t('albums.dateRange', { start, end }) : start || end;

  return <button type="button" className="album-card" onClick={onOpen} aria-label={t('albums.open', { name: album.albumName })}>
    <span className="album-cover">
      {album.albumThumbnailAssetId
        ? <ThumbnailImage src={`/api/assets/${encodeURIComponent(album.albumThumbnailAssetId)}/thumbnail`} assetId={album.albumThumbnailAssetId} surface="album" mode="original" alt="" loading="lazy" />
        : <span className="album-cover-placeholder">{t('albums.noCover')}</span>}
    </span>
    <span className="album-info">
      <span className="album-name">{album.albumName}</span>
      {period && <span className="album-period">{period}</span>}
      <span className="album-count">{t('albums.itemCount', { count: album.assetCount })}</span>
    </span>
  </button>;
}
