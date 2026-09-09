import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FormatBadge } from './FormatBadge';
import { formatPhotoDate, type AppLanguage } from './i18n';

export type { RecentAsset } from './assets';

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
  onOpen?: () => void;
};

export function PhotoCard({ asset, language, onOpen }: PhotoCardProps) {
  const { t } = useTranslation();
  return (
    <article className="photo-card">
      <button className="photo-card-button" type="button" onClick={onOpen} aria-label={t('photos.openWorkspace', { filename: asset.filename })}>
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
