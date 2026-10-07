import { useTranslation } from 'react-i18next';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import type { CSSProperties } from 'react';
import { useAppSettings } from './appSettings';
import { FormatBadge } from './FormatBadge';
import { formatPhotoDate } from './i18n';
import type { ExportQueueState } from './useExportQueue';
import { useExportQueueAssets } from './useExportQueueAssets';
import { groupExportQueueAssets, uniqueExportQueueItems, type ExportQueueAsset } from './exportQueueDisplay';

export function ExportManagementToolbar() {
  const { t } = useTranslation();
  return <div className="home-toolbar export-toolbar">
    <div className="selection-bar export-selection" role="group" aria-label={t('photos.selectionActions')}>
      <strong className="selection-count" aria-live="polite">{t('exportManagement.selectionCount', { count: 0 })}</strong>
      <div className="selection-actions">
        <button type="button" className="selection-all" disabled>{t('photos.selectAll')}</button>
        <button type="button" className="selection-clear" disabled>{t('photos.clearSelection')}</button>
      </div>
    </div>
    <div className="export-thumbnail-control"><HomeThumbnailSizeControl /></div>
    <div className="export-action-group">
      <button type="button" className="immich-action-button" disabled>{t('exportManagement.exportToImmich')}</button>
    </div>
  </div>;
}

function ExportQueueCard({ entry: { item, asset } }: { entry: ExportQueueAsset }) {
  return <article className="photo-card export-queue-card" aria-label={asset.filename}
    data-asset-id={item.assetId} data-queue-status={item.status}>
    <div className="thumbnail">
      <img src={asset.thumbnail_url} alt="" loading="lazy" />
      <FormatBadge format={asset.format} isRaw={asset.is_raw} />
    </div>
    <div className="photo-info"><p title={asset.filename}>{asset.filename}</p>
      <time dateTime={asset.date}>{formatPhotoDate(asset.date)}</time></div>
  </article>;
}

export function ExportManagementContent({ queue }: { queue: Pick<ExportQueueState, 'items' | 'loaded' | 'loading' | 'error'> }) {
  const { t } = useTranslation();
  const columns = useAppSettings().homeThumbnailColumns;
  const metadata = useExportQueueAssets(queue.items, queue.loaded);
  const items = uniqueExportQueueItems(queue.items);
  const message = queue.error ? 'queueLoadFailed' : !queue.loaded ? 'queueLoading' : !items.length ? 'empty'
    : metadata.status === 'loading' ? 'metadataLoading' : metadata.status === 'error' ? 'metadataLoadFailed' : null;
  const assets = new Map(metadata.assets.map(asset => [asset.id.toLowerCase(), asset]));
  const entries = items.flatMap(item => {
    const asset = assets.get(item.assetId.toLowerCase());
    return asset ? [{ item, asset }] : [];
  });
  return <div id="home-export-panel" className="home-tab-panel export-content" role="tabpanel" aria-labelledby="home-export-tab"
    aria-busy={queue.loading || message === 'metadataLoading'}>
    {message ? <p className="gallery-message" role={message.endsWith('Failed') ? 'alert' : message === 'empty' ? undefined : 'status'}>
      {t(`exportManagement.${message}`)}</p>
      : <div className="export-queue-grid" style={{ '--export-columns': columns } as CSSProperties}>
        {groupExportQueueAssets(entries).map(row => row.kind === 'asset'
          ? <ExportQueueCard key={row.entry.item.assetId} entry={row.entry} />
          : <section key={`stack-${row.stackId}`} className="export-stack-group" data-stack-id={row.stackId}
            aria-label={t('photos.stackAssets', { count: row.members.length })}
            style={{ '--export-member-count': row.members.length } as CSSProperties}>
            <div className="export-stack-members">{row.members.map(entry => <ExportQueueCard key={entry.item.assetId} entry={entry} />)}</div>
          </section>)}
      </div>}
  </div>;
}
