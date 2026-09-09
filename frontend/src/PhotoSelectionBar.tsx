import { useTranslation } from 'react-i18next';

type PhotoSelectionBarProps = {
  active: boolean;
  count: number;
  onClear: () => void;
  onOpen: () => void;
};

export function PhotoSelectionBar({ active, count, onClear, onOpen }: PhotoSelectionBarProps) {
  const { t } = useTranslation();
  return <div
    className={`selection-bar ${active ? 'active' : 'inactive'}`}
    role="region"
    aria-label={t('photos.selectionActions')}
    aria-hidden={!active}
  >
    <strong aria-live="polite">{t('photos.selectionCount', { count })}</strong>
    <div className="selection-actions">
      <button type="button" className="selection-clear" disabled={!active} onClick={onClear}>{t('photos.clearSelection')}</button>
      <button type="button" disabled={!active} onClick={onOpen}>{t('photos.openSelected')}</button>
    </div>
  </div>;
}
