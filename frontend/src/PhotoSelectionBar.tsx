import { useTranslation } from 'react-i18next';
import { useShortcutDisplay } from './useShortcutDisplay';

type PhotoSelectionBarProps = {
  count: number;
  canSelectAll?: boolean;
  onSelectAll?: () => void;
  onClear: () => void;
  onOpen: () => void;
  onOpenStacks?: () => void;
};

export function PhotoSelectionBar({ count, canSelectAll = false, onSelectAll, onClear, onOpen, onOpenStacks }: PhotoSelectionBarProps) {
  const { t, i18n } = useTranslation();
  const shortcut = useShortcutDisplay();
  const compactEnglish = i18n.language.startsWith('en');
  return <div className="selection-bar" role="group" aria-label={t('photos.selectionActions')}>
    <strong className="selection-count" aria-live="polite">{t('photos.selectionCount', { count })}</strong>
    <div className="selection-actions">
      <button type="button" className="selection-all" disabled={!canSelectAll || !onSelectAll} onClick={onSelectAll}>{t('photos.selectAll')}</button>
      <button type="button" className="selection-clear" aria-label={t('photos.clearSelection')} title={t('photos.clearSelection')}
        disabled={count === 0} onClick={onClear}>{t(compactEnglish ? 'photos.clearSelectionCompact' : 'photos.clearSelection')}</button>
      <button type="button" className="selection-open-stacks" aria-label={t('photos.openStacks')}
        disabled={count === 0 || !onOpenStacks} title={shortcut.title(t('photos.openStacks'), 'homeOpenStackManager')}
        onClick={onOpenStacks}>{t(compactEnglish ? 'photos.openStacksCompact' : 'photos.openStacks')}</button>
      <button type="button" className="selection-open-workspace" aria-label={t('photos.openSelected')}
        title={shortcut.title(t('photos.openSelected'), 'homeOpenSelected')} onClick={onOpen}>{t(compactEnglish ? 'photos.openSelectedCompact' : 'photos.openSelected')}</button>
    </div>
  </div>;
}
