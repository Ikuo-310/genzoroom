import { useTranslation } from 'react-i18next';

type PhotoSelectionBarProps = {
  count: number;
  onClear: () => void;
  onOpen: () => void;
};

export function PhotoSelectionBar({ count, onClear, onOpen }: PhotoSelectionBarProps) {
  const { t } = useTranslation();
  return <div className="selection-bar" role="region" aria-label={t('photos.selectionActions')}>
    <strong aria-live="polite">{t('photos.selectionCount', { count })}</strong>
    <div className="selection-actions">
      <button type="button" className="selection-clear" onClick={onClear}>{t('photos.clearSelection')}</button>
      <button type="button" onClick={onOpen}>{t('photos.openSelected')}</button>
    </div>
  </div>;
}
