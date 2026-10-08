import { useAppSettings } from './appSettings';
import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FormatBadge } from './FormatBadge';
import { StackFormatSwitches } from './StackFormatSwitches';
import { StackContextMenu, type StackQueueRow } from './StackContextMenu';
import type { AssetEditStatuses } from './editStatus';
import { FilenameDisplay } from './FilenameDisplay';
import { EditedBadge } from './EditedBadge';
import { GenzoRoomExportBadge } from './GenzoRoomExportBadge';
import type { ExportQueueStatus } from './exportQueueApi';
import { formatPhotoDate, type AppLanguage } from './i18n';
import { isPrimaryModifier } from './shortcutModifiers';
import { isGenzoRoomExported } from './photoFilters';

export type { RecentAsset } from './assets';

function stackFormatList(asset: RecentAsset) {
  const formats = asset.stackFormats?.length ? asset.stackFormats : [{ format: asset.format, isRaw: asset.is_raw }];
  const unique = formats.filter((format, index) => formats.findIndex(candidate =>
    candidate.format === format.format && candidate.isRaw === format.isRaw) === index);
  const coverIndex = unique.findIndex(format => format.format === asset.format && format.isRaw === asset.is_raw);
  return coverIndex > 0 ? [unique[coverIndex], ...unique.slice(0, coverIndex), ...unique.slice(coverIndex + 1)] : unique;
}

type PhotoCardProps = {
  asset: RecentAsset;
  language: AppLanguage;
  onSelect: () => void;
  onToggleSelection: () => void;
  onExtendSelection: () => void;
  onPreviewRequest?: () => void;
  selected?: boolean;
  selectionMode?: boolean;
  edited?: boolean;
  queueKnown?: boolean;
  queueCurrent?: boolean;
  queueStatus?: ExportQueueStatus;
  queueBusy?: boolean;
  queueVisible?: boolean;
  onQueueToggle?: () => void;
  stackMenu?: {
    members: readonly RecentAsset[] | null;
    selectedIds: ReadonlySet<string>;
    selectionAvailable: boolean;
    editStatuses: AssetEditStatuses;
    editStatusState: 'loading' | 'ready' | 'partial' | 'error';
    queueLoaded: boolean;
    queueCurrent: boolean;
    queueError: boolean;
    queueFor: (assetId: string) => StackQueueRow;
    onDarkroomToggle: (member: RecentAsset, checked: boolean) => void;
    onQueueToggle: (member: RecentAsset, checked: boolean) => void;
  };
};

export function PhotoCard({
  asset,
  language,
  onSelect,
  onToggleSelection,
  onExtendSelection,
  onPreviewRequest,
  selected = false,
  selectionMode = false,
  edited,
  queueKnown,
  queueCurrent,
  queueStatus,
  queueBusy,
  queueVisible = false,
  onQueueToggle,
  stackMenu,
}: PhotoCardProps) {
  useAppSettings();
  const { t } = useTranslation();
  const rangeClickHandled = useRef(false);
  const cardButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuPoint(null);
    if (restoreFocus) cardButtonRef.current?.focus();
  }, []);
  const selectionLabel = t(selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename });

  function handleCardClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (event.shiftKey) {
      onExtendSelection();
      return;
    }
    if (isPrimaryModifier(event.nativeEvent)) onToggleSelection();
    else onSelect();
  }

  function handleCheckboxClick(event: ReactMouseEvent<HTMLInputElement>) {
    rangeClickHandled.current = event.shiftKey;
    if (!event.shiftKey) return;
    // Prevent native checkbox activation so a follow-up change event cannot toggle the range endpoint twice.
    event.preventDefault();
    onExtendSelection();
  }

  function handleCheckboxChange() {
    if (rangeClickHandled.current) {
      rangeClickHandled.current = false;
      return;
    }
    onToggleSelection();
  }

  return (
    <article className={`photo-card${selected ? ' selected' : ''}${selectionMode ? ' selection-mode' : ''}`}
      onContextMenu={event => {
        if (!asset.stackId || !stackMenu) return;
        event.preventDefault(); event.stopPropagation();
        setMenuPoint({ x: event.clientX, y: event.clientY });
      }}>
      <label className="photo-selection-control" title={selectionLabel}>
        <input
          className="photo-selection-input"
          type="checkbox"
          checked={selected}
          onClick={handleCheckboxClick}
          onChange={handleCheckboxChange}
          aria-label={selectionLabel}
        />
      </label>
      <button
        ref={cardButtonRef}
        className="photo-card-button"
        type="button"
        onClick={handleCardClick}
        onDoubleClick={onPreviewRequest}
        aria-label={selectionLabel}
        aria-pressed={selected}
        aria-description={edited ? t('photos.edited') : undefined}
      >
        <div className="thumbnail">
          <img src={asset.thumbnail_url} alt="" loading="lazy" />
          {!(asset.stackId && Number.isSafeInteger(asset.stackAssetCount) && asset.stackAssetCount! >= 1) &&
            <div className="photo-format-badges"><FormatBadge format={asset.format} isRaw={asset.is_raw} /></div>}
        </div>
        <div className="photo-info">
          <p><FilenameDisplay filename={asset.filename} /></p>
          <time dateTime={asset.date}>{formatPhotoDate(asset.date)}</time>
        </div>
      </button>
      {asset.stackId && Number.isSafeInteger(asset.stackAssetCount) && asset.stackAssetCount! >= 1 && (
        <div className="stack-assets" role="group" aria-label={t(asset.stackAssetCount === 1 ? 'photos.invalidStack' : 'photos.stackAssets', { count: asset.stackAssetCount })}>
          <StackFormatSwitches asset={asset} formats={stackFormatList(asset)} />
          <span className={`stack-asset-count${asset.stackAssetCount === 1 ? ' stack-asset-count-error' : ''}`}>{asset.stackAssetCount}</span>
        </div>
      )}
      <div className={`photo-card-badges${isGenzoRoomExported(asset) ? ' with-export-badge' : ''}`}>
        {isGenzoRoomExported(asset) && <GenzoRoomExportBadge />}
        <EditedBadge edited={edited === true || queueVisible} queueKnown={queueKnown} queueCurrent={queueCurrent} queueStatus={queueStatus}
          showQueuedWhenUnedited
          busy={queueBusy} onQueueToggle={onQueueToggle} showQueueShortcut={false} />
      </div>
      {menuPoint && stackMenu && <StackContextMenu point={menuPoint} members={stackMenu.members}
        selectedIds={stackMenu.selectedIds} selectionAvailable={stackMenu.selectionAvailable}
        editStatuses={stackMenu.editStatuses} editStatusState={stackMenu.editStatusState}
        queueLoaded={stackMenu.queueLoaded} queueCurrent={stackMenu.queueCurrent} queueError={stackMenu.queueError} queueFor={stackMenu.queueFor}
        onDarkroomToggle={stackMenu.onDarkroomToggle} onQueueToggle={stackMenu.onQueueToggle} onClose={closeMenu} />}
    </article>
  );
}
