import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { updateSetting, useAppSettings, type HomeThumbnailColumns } from './appSettings';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { useShortcutDisplay } from './useShortcutDisplay';

export function HomeThumbnailSizeControl() {
  const { t } = useTranslation();
  const columns = useAppSettings().homeThumbnailColumns;
  const shortcut = useShortcutDisplay();
  const setColumns = useCallback((value: number) => updateSetting('homeThumbnailColumns', value as HomeThumbnailColumns), []);
  const canDecrease = columns < 10;
  const canIncrease = columns > 3;
  const decrease = useCallback(() => { if (canDecrease) setColumns(columns + 1); }, [canDecrease, columns, setColumns]);
  const increase = useCallback(() => { if (canIncrease) setColumns(columns - 1); }, [canIncrease, columns, setColumns]);
  const rank = 10 - columns;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      // The shared guard excludes ranges for arrow-key handling, but numpad sizing must not steal slider input.
      const isInputTarget = target instanceof Element && target.matches('input');
      if (event.defaultPrevented || event.isComposing || event.repeat || isNativeEditingTarget(target)
        || isInputTarget
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      const action = matchesShortcut(event, 'thumbnailSizeDecrease') && canDecrease ? decrease
        : matchesShortcut(event, 'thumbnailSizeIncrease') && canIncrease ? increase : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canDecrease, canIncrease, decrease, increase]);

  const smallerLabel = t('photos.smallerThumbnails');
  const largerLabel = t('photos.largerThumbnails');
  return <div className="thumbnail-size-control" role="group" aria-label={t('photos.thumbnailSize')}>
    <button type="button" className="thumbnail-size-icon" aria-label={smallerLabel} title={shortcut.title(smallerLabel, 'thumbnailSizeDecrease')}
      disabled={!canDecrease} onClick={decrease}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z" /></svg>
    </button>
    <input type="range" min="0" max="7" step="1" value={rank} aria-label={t('photos.thumbnailSize')}
      aria-valuetext={t('photos.thumbnailColumns', { count: columns })}
      onChange={event => setColumns(10 - Number(event.currentTarget.value))} />
    <button type="button" className="thumbnail-size-icon" aria-label={largerLabel} title={shortcut.title(largerLabel, 'thumbnailSizeIncrease')}
      disabled={!canIncrease} onClick={increase}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h14v14H3z" /></svg>
    </button>
    <span className="visually-hidden">{t('photos.thumbnailColumns', { count: columns })}</span>
  </div>;
}
