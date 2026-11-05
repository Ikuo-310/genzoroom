import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { HOME_THUMBNAIL_WIDTHS, updateSetting, useAppSettings, type HomeThumbnailWidth } from './appSettings';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { useShortcutDisplay } from './useShortcutDisplay';

export function HomeThumbnailSizeControl() {
  const { t } = useTranslation();
  const width = useAppSettings().homeThumbnailWidth;
  const rank = HOME_THUMBNAIL_WIDTHS.indexOf(width);
  const shortcut = useShortcutDisplay();
  const setSize = useCallback((value: number) => updateSetting('homeThumbnailWidth', HOME_THUMBNAIL_WIDTHS[value] as HomeThumbnailWidth), []);
  const canDecrease = rank > 0;
  const canIncrease = rank < HOME_THUMBNAIL_WIDTHS.length - 1;
  const decrease = useCallback(() => { if (canDecrease) setSize(rank - 1); }, [canDecrease, rank, setSize]);
  const increase = useCallback(() => { if (canIncrease) setSize(rank + 1); }, [canIncrease, rank, setSize]);

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
      aria-valuetext={t('photos.thumbnailWidth', { width })}
      onChange={event => setSize(Number(event.currentTarget.value))} />
    <button type="button" className="thumbnail-size-icon" aria-label={largerLabel} title={shortcut.title(largerLabel, 'thumbnailSizeIncrease')}
      disabled={!canIncrease} onClick={increase}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h14v14H3z" /></svg>
    </button>
    <span className="visually-hidden">{t('photos.thumbnailWidth', { width })}</span>
  </div>;
}
