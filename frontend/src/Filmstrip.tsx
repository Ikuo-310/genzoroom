import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { EditedBadge } from './EditedBadge';
import { FormatBadge } from './FormatBadge';
import type { AssetEditStatuses } from './editStatus';
import { revealFilmstripItem } from './filmstripNavigation';
import { isNativeEditingTarget } from './editShortcuts';

export function Filmstrip({ assets, activeAssetId, onActivate, disabled = false, keyboardBlocked = false, editStatuses = {} }: {
  assets: RecentAsset[]; activeAssetId: string; onActivate: (id: string) => void; disabled?: boolean; keyboardBlocked?: boolean;
  editStatuses?: AssetEditStatuses;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const focusDestination = useRef<string | null>(null);
  const latest = useRef({ assets, activeAssetId, onActivate, disabled, keyboardBlocked });
  latest.current = { assets, activeAssetId, onActivate, disabled, keyboardBlocked };
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const current = latest.current;
    const region = scroll.current;
    if (!region || current.disabled || current.keyboardBlocked || event.defaultPrevented || event.isComposing
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (region.ownerDocument.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
    const focused = region.ownerDocument.activeElement;
    const inside = !!focused && region.contains(focused);
    if (!inside && !hovered.current) return;
    if (!inside && focused && focused !== region.ownerDocument.body && focused !== region.ownerDocument.documentElement
      && !(focused instanceof HTMLInputElement && focused.type === 'range')) return;
    if (isNativeEditingTarget(event.target)) return;
    event.preventDefault();
    const index = current.assets.findIndex((asset) => asset.id === current.activeAssetId);
    const destination = index < 0 ? undefined : current.assets[index + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!destination) return;
    focusDestination.current = inside ? destination.id : null;
    current.onActivate(destination.id);
  }, []);
  const handlePointerMove = useCallback((event: PointerEvent) => {
    const previous = pointerPosition.current;
    const moved = (previous !== null && (previous.x !== event.clientX || previous.y !== event.clientY))
      || !!event.movementX || !!event.movementY;
    pointerPosition.current = { x: event.clientX, y: event.clientY };
    if (moved && scroll.current) hovered.current = event.target instanceof Node && scroll.current.contains(event.target);
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
    };
  }, [handleKeyDown, handlePointerMove]);
  useEffect(() => {
    const region = scroll.current;
    const active = region?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    if (!region || !active) return;
    revealFilmstripItem(region, active);
    if (!disabled && !keyboardBlocked && focusDestination.current === activeAssetId) {
      focusDestination.current = null;
      const focused = region.ownerDocument.activeElement;
      if (focused === region.ownerDocument.body || (focused && region.contains(focused))) active.focus({ preventScroll: true });
    }
  }, [activeAssetId, assets, disabled, keyboardBlocked]);
  return <section className="filmstrip" aria-label={t('workspace.filmstrip')}>
    <div ref={scroll} className="filmstrip-scroll"
      onKeyDown={(event) => handleKeyDown(event.nativeEvent)}>
      {assets.map((asset) => <button
        key={asset.id}
        type="button"
        disabled={disabled}
        className={`filmstrip-item${asset.id === activeAssetId ? ' active' : ''}`}
        onClick={() => { focusDestination.current = null; onActivate(asset.id); }}
        aria-current={asset.id === activeAssetId ? 'true' : undefined}
        aria-label={asset.filename}
        aria-description={editStatuses[asset.id] ? t('photos.edited') : undefined}
      >
        <img src={asset.thumbnail_url} alt="" />
        <FormatBadge format={asset.format} isRaw={asset.is_raw} />
        <EditedBadge edited={editStatuses[asset.id]} />
      </button>)}
    </div>
  </section>;
}
