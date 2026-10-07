import { useTranslation } from 'react-i18next';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { useRef, type CSSProperties, type MouseEvent } from 'react';
import { useAppSettings } from './appSettings';
import { FormatBadge } from './FormatBadge';
import { formatPhotoDate } from './i18n';
import type { ExportQueueAsset } from './exportQueueDisplay';
import { isMutableExportStatus, type ExportManagementState } from './useExportManagement';
import { isPrimaryModifier } from './shortcutModifiers';
import { useShortcutDisplay } from './useShortcutDisplay';

export function ExportManagementToolbar({ management }: { management: ExportManagementState }) {
  const { t } = useTranslation();
  const shortcut = useShortcutDisplay();
  const noSelection = !management.selectedIds.length;
  const busy = management.removing || management.undoing;
  return <div className="home-toolbar export-toolbar">
    <div className="selection-bar export-selection" role="group" aria-label={t('photos.selectionActions')}>
      <strong className="selection-count" aria-live="polite">{t('exportManagement.selectionCount', { count: management.selectedIds.length })}</strong>
      <div className="selection-actions">
        <button type="button" className="selection-all" disabled={busy || !management.hasVisibleMutable} onClick={management.selectAll}>{t('photos.selectAll')}</button>
        <button type="button" className="selection-clear" disabled={busy || noSelection} onClick={management.clear}>{t('photos.clearSelection')}</button>
        <button type="button" className="export-arm-toggle" disabled={busy || noSelection || !!management.message} onClick={management.toggleArmed}>
          {shortcut.inline(t(`exportManagement.${management.allSelectedArmed ? 'disarm' : 'arm'}`), 'exportArmToggle')}</button>
        <button type="button" className="export-queue-remove" disabled={busy || noSelection || !!management.message} onClick={management.removeSelected}>
          {shortcut.inline(t('exportManagement.remove'), 'exportQueueToggle')}</button>
      </div>
    </div>
    <div className="export-thumbnail-control"><HomeThumbnailSizeControl /></div>
    <div className="export-action-group">
      <button type="button" className="immich-action-button" disabled>{t('exportManagement.exportToImmich')}</button>
    </div>
  </div>;
}

function ExportQueueCard({ entry: { item, asset }, management }: { entry: ExportQueueAsset; management: ExportManagementState }) {
  const { t } = useTranslation();
  const id = item.assetId.toLowerCase();
  const selected = management.selectedIds.includes(id);
  const armed = management.armedIds.has(id);
  const locked = !isMutableExportStatus(item.status);
  const disabled = locked || management.removing || management.undoing || !!management.queue.mutationFor(id).operation;
  const label = t(selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename });
  const rangeClickHandled = useRef(false);
  function handleCardClick(event: MouseEvent<HTMLButtonElement>) {
    if (event.shiftKey) management.extendRange(id);
    else if (isPrimaryModifier(event.nativeEvent)) management.toggleSelection(id);
    else management.selectOnly(id);
  }
  function handleCheckboxClick(event: MouseEvent<HTMLInputElement>) {
    rangeClickHandled.current = event.shiftKey;
    if (!event.shiftKey) return;
    // Native activation would otherwise toggle the endpoint after the shared range operation.
    event.preventDefault(); management.extendRange(id);
  }
  function handleCheckboxChange() {
    if (rangeClickHandled.current) { rangeClickHandled.current = false; return; }
    management.toggleSelection(id);
  }
  return <article className={`photo-card export-queue-card${selected ? ' selected' : ''}${management.selectedIds.length ? ' selection-mode' : ''}`} aria-label={asset.filename}
    data-asset-id={item.assetId} data-queue-status={item.status} aria-disabled={locked || undefined}>
    <label className="photo-selection-control" title={locked ? t('exportManagement.locked') : label}>
      <input className="photo-selection-input" type="checkbox" checked={selected} disabled={disabled}
        onClick={handleCheckboxClick} onChange={handleCheckboxChange} aria-label={label} />
    </label>
    <button className="photo-card-button" type="button" disabled={disabled} onClick={handleCardClick}
      aria-label={label} aria-pressed={selected} aria-description={locked ? t('exportManagement.locked') : armed ? t('exportManagement.armed') : undefined}>
    <div className="thumbnail">
      <img src={asset.thumbnail_url} alt="" loading="lazy" />
      <FormatBadge format={asset.format} isRaw={asset.is_raw} />
      {armed && <span className="export-status-bar export-status-armed">{t('exportManagement.armed')}</span>}
    </div>
    <div className="photo-info"><p title={asset.filename}>{asset.filename}</p>
      <time dateTime={asset.date}>{formatPhotoDate(asset.date)}</time></div>
    </button>
  </article>;
}

export function ExportManagementContent({ management }: { management: ExportManagementState }) {
  const { t } = useTranslation();
  const columns = useAppSettings().homeThumbnailColumns;
  const { queue, message, rows } = management;
  return <div id="home-export-panel" className="home-tab-panel export-content" role="tabpanel" aria-labelledby="home-export-tab"
    aria-busy={queue.loading || message === 'metadataLoading'}>
    {management.removalError && <p className="gallery-message export-removal-error" role="alert">{t(`exportManagement.${management.removalError}`)}</p>}
    {message ? <p className="gallery-message" role={message.endsWith('Failed') ? 'alert' : message === 'empty' ? undefined : 'status'}>
      {t(`exportManagement.${message}`)}</p>
      : <div className="export-queue-grid" style={{ '--export-columns': columns } as CSSProperties}>
        {rows.map(row => row.kind === 'asset'
          ? <ExportQueueCard key={row.entry.item.assetId} entry={row.entry} management={management} />
          : <section key={`stack-${row.stackId}`} className="export-stack-group" data-stack-id={row.stackId}
            aria-label={t('photos.stackAssets', { count: row.members.length })}
            style={{ '--export-member-count': row.members.length } as CSSProperties}>
            <div className="export-stack-members">{row.members.map(entry => <ExportQueueCard key={entry.item.assetId} entry={entry} management={management} />)}</div>
          </section>)}
      </div>}
  </div>;
}
