import { useTranslation } from 'react-i18next';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';

export function ExportManagementToolbar() {
  const { t } = useTranslation();
  return <div className="home-toolbar export-toolbar">
    <div className="export-selection" role="group" aria-label={t('photos.selectionActions')}>
      <strong aria-live="polite">{t('exportManagement.selectionCount', { count: 0 })}</strong>
      <button type="button" disabled>{t('photos.clearSelection')}</button>
    </div>
    <div className="export-thumbnail-control"><HomeThumbnailSizeControl /></div>
    <div className="export-action-group">
      <button type="button" className="immich-action-button" disabled>{t('exportManagement.exportToImmich')}</button>
    </div>
  </div>;
}

export function ExportManagementContent() {
  const { t } = useTranslation();
  return <div id="home-export-panel" className="home-tab-panel export-content" role="tabpanel" aria-labelledby="home-export-tab">
    <p className="gallery-message">{t('exportManagement.empty')}</p>
  </div>;
}
