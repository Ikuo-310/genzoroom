import { formatPhotoDate, type AppLanguage } from './i18n';

export type RecentAsset = {
  id: string;
  filename: string;
  date: string;
  thumbnail_url: string;
  format: string;
  is_raw: boolean;
};

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
};

export function PhotoCard({ asset, language }: PhotoCardProps) {
  return (
    <article className="photo-card">
      <div className="thumbnail">
        <img src={asset.thumbnail_url} alt={asset.filename} loading="lazy" />
        <span className={`format-badge${asset.is_raw ? ' raw' : ''}`}>
          {asset.format}
        </span>
      </div>
      <div className="photo-info">
        <p title={asset.filename}>{asset.filename}</p>
        <time dateTime={asset.date}>{formatPhotoDate(asset.date, language)}</time>
      </div>
    </article>
  );
}
