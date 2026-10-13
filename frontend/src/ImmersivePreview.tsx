import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { canToggleEditedQueue, type EditedQueueControlState } from './EditedBadge';
import { GenzoRoomExportBadge } from './GenzoRoomExportBadge';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { isGenzoRoomExported } from './photoFilters';
import { shortcutPlatform } from './shortcutModifiers';
import { useShortcutDisplay } from './useShortcutDisplay';

export type ImmersiveQueueControlState = EditedQueueControlState;

export type ImmersivePreviewProps = {
  assets: readonly RecentAsset[];
  startAssetId: string;
  selectedAssetIds?: ReadonlySet<string>;
  queuedAssetIds?: ReadonlySet<string>;
  queueControlByAssetId?: ReadonlyMap<string, ImmersiveQueueControlState>;
  armedAssetIds?: ReadonlySet<string>;
  exportControlByAssetId?: ReadonlyMap<string, { queueEnabled: boolean; armEnabled: boolean }>;
  source: 'gallery' | 'exportManagement' | 'stackManagement';
  preferEditedPreview?: boolean;
  onToggleSelection?: (assetId: string) => void;
  onToggleQueue?: (assetId: string) => void;
  onToggleArmed?: (assetId: string) => void;
  onClose: () => void;
};

function includes(ids: ReadonlySet<string>, assetId: string) {
  return ids.has(assetId) || ids.has(assetId.toLowerCase());
}

export function ImmersivePreview({ assets, startAssetId, selectedAssetIds = new Set(), queuedAssetIds = new Set(), armedAssetIds = new Set(),
  queueControlByAssetId, exportControlByAssetId, source, preferEditedPreview = true, onToggleSelection, onToggleQueue, onToggleArmed, onClose }: ImmersivePreviewProps) {
  const { t } = useTranslation();
  const shortcut = useShortcutDisplay();
  const rootRef = useRef<HTMLElement>(null);
  // Queue and selection updates from the parent must not change the sequence being browsed.
  const [viewAssets] = useState(() => [...assets]);
  // The opening switch chooses the image source for the entire browsing session.
  const [useEditedPreview] = useState(preferEditedPreview);
  const [index, setIndex] = useState(() => Math.max(0, assets.findIndex(asset => asset.id.toLowerCase() === startAssetId.toLowerCase())));
  const asset = viewAssets[index];
  const isMac = shortcutPlatform() === 'mac';
  const hasArm = source === 'exportManagement' && onToggleArmed !== undefined;
  const queueControl = asset ? queueControlByAssetId?.get(asset.id.toLowerCase()) : undefined;
  const exportControl = asset ? exportControlByAssetId?.get(asset.id.toLowerCase()) : undefined;
  const queueEnabled = source === 'exportManagement' ? exportControl?.queueEnabled === true
    : queueControlByAssetId === undefined || (queueControl !== undefined && canToggleEditedQueue(queueControl, true));
  const armEnabled = hasArm && exportControl?.armEnabled === true;
  const move = useCallback((direction: -1 | 1) => {
    setIndex(current => Math.max(0, Math.min(viewAssets.length - 1, current + direction)));
  }, [viewAssets.length]);
  const handlePhotoClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || window.innerWidth <= 0) return;
    const position = event.clientX / window.innerWidth;
    if (position < 0.2) move(-1);
    else if (position >= 0.8) move(1);
  };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Tab') {
        const root = rootRef.current;
        const focusable = root ? [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
        const first = focusable[0], last = focusable.at(-1), focused = document.activeElement;
        if (root && focusable.length && (!root.contains(focused)
          || event.shiftKey && (focused === first || focused === root)
          || !event.shiftKey && focused === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
          return;
        }
      }
      if (event.defaultPrevented || event.isComposing || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (source === 'stackManagement') {
        // Home and Stack listeners must not react to commands behind the read-only Preview.
        event.stopImmediatePropagation();
        if (matchesShortcut(event, 'immersiveSelectionToggle') || matchesShortcut(event, 'exportQueueToggle')
          || matchesShortcut(event, 'exportArmToggle')) { consume(event); return; }
      }
      // Export never uses Space, including repeats that could activate a focused Q/W button natively.
      if (source === 'exportManagement' && matchesShortcut(event, 'immersiveSelectionToggle')) {
        consume(event); return;
      }
      if (event.repeat) return;
      if (matchesShortcut(event, 'immersivePrevious')) {
        consume(event); move(-1);
      } else if (matchesShortcut(event, 'immersiveNext')) {
        consume(event); move(1);
      } else if (matchesShortcut(event, 'immersiveSelectionToggle')) {
        if (!asset) return;
        consume(event); if (source === 'gallery') onToggleSelection?.(asset.id);
      } else if (matchesShortcut(event, 'exportQueueToggle')) {
        if (!asset) return;
        consume(event); if (queueEnabled) onToggleQueue?.(asset.id);
      } else if (hasArm && matchesShortcut(event, 'exportArmToggle')) {
        if (!asset) return;
        consume(event); if (armEnabled) onToggleArmed?.(asset.id);
      } else if (matchesShortcut(event, 'immersiveClose') || event.key === 'Escape') {
        consume(event); onClose();
      }
    };
    // Capture prevents the underlying Gallery or Workspace from also handling shared Q/W commands.
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [asset, armEnabled, hasArm, move, onClose, onToggleArmed, onToggleQueue, onToggleSelection, queueEnabled, source, viewAssets.length]);

  if (!asset) return null;
  const selected = includes(selectedAssetIds, asset.id);
  const queued = includes(queuedAssetIds, asset.id);
  const armed = includes(armedAssetIds, asset.id);
  const closeLabel = t('immersivePreview.close');
  const closeButton = <button className="immersive-preview-close" type="button" onClick={onClose} aria-label={closeLabel}
    title={shortcut.title(closeLabel, 'immersiveClose')}>×</button>;
  const position = <span className="immersive-preview-position" aria-label={t('immersivePreview.position', { current: index + 1, total: viewAssets.length })}>{index + 1} / {viewAssets.length}</span>;

  return <section ref={rootRef} tabIndex={-1} className={`immersive-preview${isMac ? ' immersive-preview-mac' : ''}`} data-platform={isMac ? 'mac' : 'other'} aria-label={t('immersivePreview.title')}>
    <header className="immersive-preview-topbar">
      {isMac ? closeButton : position}
      <div className="immersive-preview-title">
        <span className="immersive-preview-title-side immersive-preview-title-badge">
          {isGenzoRoomExported(asset) && <GenzoRoomExportBadge />}
        </span>
        <span className="immersive-preview-filename" title={asset.filename}>{asset.filename}</span>
        <span className="immersive-preview-title-side" aria-hidden="true" />
      </div>
      {isMac ? position : closeButton}
    </header>
    <main className="immersive-preview-photo" onClick={handlePhotoClick}>
      <img src={`/api/assets/${encodeURIComponent(asset.id)}/${useEditedPreview ? 'immersive-preview' : 'preview'}`} alt={asset.filename} draggable={false} />
    </main>
    <footer className="immersive-preview-bottombar">
      {source === 'gallery' && <button type="button" aria-pressed={selected} onClick={() => onToggleSelection?.(asset.id)}>
        {t('immersivePreview.selection', { state: t(selected ? 'immersivePreview.on' : 'immersivePreview.off') })}{shortcut.label('immersiveSelectionToggle') && <kbd>{shortcut.label('immersiveSelectionToggle')}</kbd>}
      </button>}
      {source !== 'stackManagement' && <button type="button" className={!queueEnabled ? 'immersive-preview-queue-disabled' : undefined}
        aria-pressed={queued} disabled={!queueEnabled} onClick={() => onToggleQueue?.(asset.id)}>
        {t('immersivePreview.queue', { state: t(queued ? 'immersivePreview.on' : 'immersivePreview.off') })}{shortcut.label('exportQueueToggle') && <kbd>{shortcut.label('exportQueueToggle')}</kbd>}
      </button>}
      {hasArm && <button type="button" className={!armEnabled ? 'immersive-preview-queue-disabled' : undefined}
        aria-pressed={armed} disabled={!armEnabled} onClick={() => onToggleArmed?.(asset.id)}>
        {t('immersivePreview.arm', { state: t(armed ? 'immersivePreview.on' : 'immersivePreview.off') })}{shortcut.label('exportArmToggle') && <kbd>{shortcut.label('exportArmToggle')}</kbd>}
      </button>}
    </footer>
  </section>;
}
