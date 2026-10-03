import { useTranslation } from 'react-i18next';
import { useShortcutDisplay } from './useShortcutDisplay';

type PhotoSelectionBarProps = {
  active: boolean;
  count: number;
  onClear: () => void;
  onOpen: () => void;
  onOpenStacks?: () => void;
};

export function PhotoSelectionBar({ active, count, onClear, onOpen, onOpenStacks }: PhotoSelectionBarProps) {
  const { t } = useTranslation();
  const shortcut = useShortcutDisplay();
  return <div
    className={`selection-bar ${active ? 'active' : 'inactive'}`}
    role="region"
    aria-label={t('photos.selectionActions')}
    aria-hidden={!active}
  >
    <strong aria-live="polite">{t('photos.selectionCount', { count })}</strong>
    <div className="selection-actions">
      <button type="button" className="selection-clear" disabled={!active} onClick={onClear}>{t('photos.clearSelection')}</button>
      <button type="button" className="selection-open-workspace" disabled={!active} title={shortcut.title(t('photos.openSelected'), 'homeOpenSelected')} onClick={onOpen}>{t('photos.openSelected')}</button>
      <button type="button" disabled={!active || count === 0 || !onOpenStacks} title={shortcut.title(t('photos.openStacks'), 'homeOpenStackManager')} onClick={onOpenStacks}>{t('photos.openStacks')}</button>
    </div>
  </div>;
}
