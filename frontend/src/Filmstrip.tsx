import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { EditedBadge, EditedBadgeIcon } from './EditedBadge';
import { FormatBadge } from './FormatBadge';
import type { AssetEditStatuses } from './editStatus';
import type { ExportQueueStatus } from './exportQueueApi';
import { revealFilmstripItem } from './filmstripNavigation';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';

export function Filmstrip({ assets, activeAssetId, onActivate, disabled = false, keyboardBlocked = false, editStatuses = {}, historyOnlyStatuses = {}, queueKnown, queueCurrent, queueStatusFor, queueBusyFor, onQueueToggle }: {
  assets: RecentAsset[]; activeAssetId: string; onActivate: (id: string) => void; disabled?: boolean; keyboardBlocked?: boolean;
  editStatuses?: AssetEditStatuses;
  historyOnlyStatuses?: AssetEditStatuses;
  queueKnown?: boolean;
  queueCurrent?: boolean;
  queueStatusFor?: (id: string) => ExportQueueStatus | undefined;
  queueBusyFor?: (id: string) => boolean;
  onQueueToggle?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const latest = useRef({ assets, activeAssetId, onActivate, disabled, keyboardBlocked });
  latest.current = { assets, activeAssetId, onActivate, disabled, keyboardBlocked };
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const current = latest.current;
    const region = scroll.current;
    if (!region || current.disabled || current.keyboardBlocked || event.defaultPrevented || event.isComposing || event.repeat
      || isNativeEditingTarget(event.target)) return;
    const direction = matchesShortcut(event, 'filmstripPrevious') ? -1
      : matchesShortcut(event, 'filmstripNext') ? 1 : 0;
    if (!direction) return;
    if (region.ownerDocument.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
    event.preventDefault();
    const index = current.assets.findIndex((asset) => asset.id === current.activeAssetId);
    const destination = index < 0 ? undefined : current.assets[index + direction];
    if (!destination) return;
    current.onActivate(destination.id);
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);
  useEffect(() => {
    const region = scroll.current;
    const active = region?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    if (!region || !active) return;
    revealFilmstripItem(region, active);
  }, [activeAssetId, assets, disabled, keyboardBlocked]);
  return <section className="filmstrip" aria-label={t('workspace.filmstrip')}>
    <div ref={scroll} className="filmstrip-scroll">
      {assets.map((asset) => <div key={asset.id} className="filmstrip-entry"><button
        type="button"
        disabled={disabled}
        className={`filmstrip-item${asset.id === activeAssetId ? ' active' : ''}`}
        onClick={() => onActivate(asset.id)}
        aria-current={asset.id === activeAssetId ? 'true' : undefined}
        aria-label={asset.filename}
        aria-description={editStatuses[asset.id] ? t('photos.edited')
          : historyOnlyStatuses[asset.id] ? t('workspace.historyRetained') : undefined}
      >
        <img src={asset.thumbnail_url} alt="" />
        <FormatBadge format={asset.format} isRaw={asset.is_raw} />
      </button>
        {editStatuses[asset.id] !== true && historyOnlyStatuses[asset.id] === true
          ? <span className="filmstrip-history-badge" role="img" aria-label={t('workspace.historyRetained')} title={t('workspace.historyRetained')}>
            <EditedBadgeIcon />
          </span>
          : <EditedBadge edited={editStatuses[asset.id]} queueKnown={queueKnown} queueCurrent={queueCurrent}
          queueStatus={queueStatusFor?.(asset.id)} busy={queueBusyFor?.(asset.id)}
          disabled={disabled || keyboardBlocked}
          onQueueToggle={onQueueToggle ? () => onQueueToggle(asset.id) : undefined} />}
      </div>)}
    </div>
  </section>;
}
