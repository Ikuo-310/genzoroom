import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampZoom, zoomAroundPoint, type Point } from './viewerMath';
import { AdjustedImage } from './AdjustedImage';
import { activeAdjustmentId } from './adjustmentFocus';
import { editClipboardShortcut, editSelectionShortcut, isNativeEditingTarget, matchesShortcut, matchesShortcutKey } from './editShortcuts';
import { EditSettingsMenu } from './EditSettingsMenu';
import { useShortcutDisplay } from './useShortcutDisplay';
import type { EditRecipe } from './editing';
import type { EditImageSource } from './editImageSource';
import type { WorkspaceGpuRenderer, ProcessingBackend } from './useWorkspaceGpu';
import type { HistogramChangeHandler } from './histogram';

type ImageViewerProps = {
  src: string;
  documentKey?: string;
  rawFrame?: { nativeWidth: number; nativeHeight: number; geometryId: string };
  onRawViewChange?: () => void;
  previewStatus?: 'loading' | 'error';
  statusNote?: string;
  previewPixels?: boolean;
  beforeAvailable?: boolean;
  beforeSrc?: string;
  beforeStatus?: 'loading' | 'ready' | 'error';
  onBeforeRetry?: () => void;
  editSource?: EditImageSource;
  originalStatus?: 'loading' | 'ready' | 'error';
  showingOriginal?: boolean;
  onOriginalToggle?: () => void;
  onImageError?: () => void;
  recipe?: EditRecipe;
  onHistogramChange?: HistogramChangeHandler;
  gpuRenderer?: WorkspaceGpuRenderer | null;
  onGpuError?: (renderer: WorkspaceGpuRenderer, error: unknown) => void;
  onBackendChange?: (backend: ProcessingBackend) => void;
  alt: string;
  leftOpen: boolean;
  rightOpen: boolean;
  persistentBeforeAdjustments?: boolean;
  onBeforeAdjustmentsChange?: (value: boolean) => void;
  onBeforeAdjustmentsDisplayChange?: (value: boolean) => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onCopyAdjustments?: () => boolean;
  onPasteAdjustments?: () => boolean;
  onSelectCopyAdjustments?: () => boolean;
  onSelectPasteAdjustments?: () => boolean;
  editClipboardDisabled?: boolean;
  hasEditClipboard?: boolean;
  keyboardBlocked?: boolean;
};

const EMPTY_IMAGE_SIZE: Point = { x: 0, y: 0 };

export function ImageViewer({ src, documentKey, rawFrame, onRawViewChange, previewStatus, statusNote, previewPixels = false, beforeAvailable = true, beforeSrc, beforeStatus, onBeforeRetry, editSource, originalStatus, showingOriginal = false, onOriginalToggle, onImageError, recipe, onHistogramChange, gpuRenderer, onGpuError, onBackendChange, alt, leftOpen, rightOpen, persistentBeforeAdjustments = false, onBeforeAdjustmentsChange, onBeforeAdjustmentsDisplayChange, onToggleLeft, onToggleRight, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments, editClipboardDisabled = true, hasEditClipboard = false, keyboardBlocked = false }: ImageViewerProps) {
  const { t } = useTranslation();
  const shortcut = useShortcutDisplay();
  const beforeShortcut = shortcut.label('viewerBefore');
  const fitShortcut = shortcut.label('viewerFitRestore');
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageIdentity = documentKey ?? `${src}:${editSource?.kind ?? ''}:${editSource?.url ?? ''}`;
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number; keyboard?: boolean } | null>(null);
  const [closeToolbarMenuSignal, setCloseToolbarMenuSignal] = useState(0);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  // Identity-tagged load state prevents a late passive effect from undoing an already-fired load event.
  const [loadedImage, setLoadedImage] = useState<{ identity: string; status: 'ready' | 'error'; size: Point } | null>(null);
  const imageState = loadedImage?.identity === imageIdentity ? loadedImage.status : 'loading';
  const bitmapSize = loadedImage?.identity === imageIdentity ? loadedImage.size : EMPTY_IMAGE_SIZE;
  const logicalWidth = rawFrame?.nativeWidth ?? bitmapSize.x, logicalHeight = rawFrame?.nativeHeight ?? bitmapSize.y;
  const imageSize = useMemo(() => ({ x: logicalWidth, y: logicalHeight }), [logicalWidth, logicalHeight]);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const media = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    const changed = () => setDpr(window.devicePixelRatio || 1);
    media?.addEventListener('change', changed);
    window.addEventListener('resize', changed);
    return () => { media?.removeEventListener('change', changed); window.removeEventListener('resize', changed); };
  }, [dpr]);
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const previousTransform = useRef<{ scale: number; pan: Point } | null>(null);
  const previousDpr = useRef(dpr);
  useEffect(() => {
    const ratio = previousDpr.current / dpr;
    previousDpr.current = dpr;
    if (!rawFrame || ratio === 1) return;
    // Keep physical RAW magnification stable when the window moves between displays.
    if (!fitMode) setScale(current => current * ratio);
    if (previousTransform.current) previousTransform.current.scale *= ratio;
  }, [dpr, !!rawFrame, fitMode]);
  const previousNativeSize = useRef<{ identity: string; x: number; y: number } | null>(null);
  const viewCallback = useRef(onRawViewChange);
  viewCallback.current = onRawViewChange;
  useEffect(() => { viewCallback.current?.(); }, [scale, pan.x, pan.y, dpr, rawFrame?.geometryId]);
  const [backslashHeld, setBackslashHeld] = useState(false);
  const showBeforeAdjustments = beforeAvailable && (persistentBeforeAdjustments || backslashHeld);
  useLayoutEffect(() => {
    onBeforeAdjustmentsDisplayChange?.(showBeforeAdjustments);
  }, [showBeforeAdjustments, onBeforeAdjustmentsDisplayChange]);
  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenuPosition(null);
    if (restoreFocus) viewportRef.current?.focus({ preventScroll: true });
  }, []);
  const openContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (keyboardBlocked || event.button !== 2 || !onCopyAdjustments || !onPasteAdjustments
      || !onSelectCopyAdjustments || !onSelectPasteAdjustments) return;
    event.preventDefault();
    setCloseToolbarMenuSignal((current) => current + 1);
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, [keyboardBlocked, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments]);

  useEffect(() => { setContextMenuPosition(null); }, [src]);

  useEffect(() => {
    if (keyboardBlocked) setBackslashHeld(false);
    const keydown = (event: KeyboardEvent) => {
      if (keyboardBlocked || event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      if (matchesShortcut(event, 'viewerOriginal')) {
        // JIS Backslash also matches Original; keep this branch first to avoid showing Before.
        if (originalStatus === 'ready' && editSource && onOriginalToggle) {
          event.preventDefault();
          if (!event.repeat) onOriginalToggle();
        } else if (matchesShortcut(event, 'viewerBefore')) {
          event.preventDefault();
        }
      } else if (matchesShortcut(event, 'viewerBefore')) {
        event.preventDefault();
        if (beforeAvailable && !event.repeat) setBackslashHeld(true);
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (matchesShortcutKey(event, 'viewerBefore')) setBackslashHeld(false);
    };
    const release = () => setBackslashHeld(false);
    const visibilityChange = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, [editSource, keyboardBlocked, onOriginalToggle, originalStatus, beforeAvailable]);

  // A new native frame is not a new document: preserve the user's zoom and pan.
  useEffect(() => {
    setFitMode(true);
    setPan({ x: 0, y: 0 });
    previousTransform.current = null;
  }, [imageIdentity]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || imageSize.x === 0) return;
    const updateFit = () => {
      const next = calculateFitScale(
        { x: viewport.clientWidth, y: viewport.clientHeight },
        imageSize,
      );
      setFitScale(next);
      if (fitMode) {
        setScale(next);
        setPan({ x: 0, y: 0 });
      }
      viewCallback.current?.();
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitMode, imageSize]);

  useLayoutEffect(() => {
    const previous = previousNativeSize.current;
    previousNativeSize.current = { identity: imageIdentity, ...imageSize };
    const viewport = viewportRef.current;
    if (!previewPixels || !viewport || fitMode || !imageSize.x || !imageSize.y || !previous
      || previous.identity !== imageIdentity || !previous.x || !previous.y
      || previous.x === imageSize.x && previous.y === imageSize.y) return;
    // Native crop/orientation can change frame dimensions; identical comparison frames keep their exact pan.
    const x = Math.max(0, (imageSize.x * scale - viewport.clientWidth) / 2);
    const y = Math.max(0, (imageSize.y * scale - viewport.clientHeight) / 2);
    previousTransform.current = null;
    setPan(current => ({ x: Math.max(-x, Math.min(x, current.x)), y: Math.max(-y, Math.min(y, current.y)) }));
  }, [previewPixels, imageIdentity, imageSize.x, imageSize.y, fitMode, scale]);

  // Explicit view controls discard the return point instead of reviving an older zoom.
  function fit() {
    previousTransform.current = null;
    setFitMode(true);
    setScale(fitScale);
    setPan({ x: 0, y: 0 });
  }

  function setActualSize() {
    previousTransform.current = null;
    setFitMode(false);
    setScale(rawFrame ? 1 / dpr : 1);
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (keyboardBlocked || event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target) || !matchesShortcut(event, 'viewerFitRestore')
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      event.preventDefault();
      if (!fitMode) {
        previousTransform.current = { scale, pan };
        setFitMode(true);
        setScale(fitScale);
        setPan({ x: 0, y: 0 });
      } else if (previousTransform.current) {
        setFitMode(false);
        setScale(previousTransform.current.scale);
        setPan(previousTransform.current.pan);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [keyboardBlocked, fitMode, scale, pan, fitScale]);

  function zoom(nextValue: number, point: Point = { x: 0, y: 0 }) {
    const next = rawFrame ? clampZoom(nextValue * dpr) / dpr : clampZoom(nextValue);
    setFitMode(false);
    setPan((current) => zoomAroundPoint(current, point, scale, next));
    setScale(next);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (imageSize.x === 0) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
    zoom(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), point);
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (scale <= fitScale || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, pan };
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({ x: drag.pan.x + event.clientX - drag.origin.x, y: drag.pan.y + event.clientY - drag.origin.y });
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  return <section className="viewer-panel" aria-label={t('workspace.viewer')}>
    <div className="viewer-toolbar">
      <button type="button" className="tool-button icon-button panel-toggle" onClick={onToggleLeft}
        aria-label={t(leftOpen ? 'workspace.collapseLeft' : 'workspace.expandLeft')}
        title={t(leftOpen ? 'workspace.collapseLeft' : 'workspace.expandLeft')} aria-pressed={leftOpen}>
        <span aria-hidden="true">{leftOpen ? '‹' : '›'}</span>
      </button>
      <div className="zoom-controls" role="group" aria-label={t('workspace.zoomControls')}>
        <button type="button" className="tool-button" onClick={fit}
          title={fitShortcut ? t('workspace.fitShortcutHint', { shortcut: fitShortcut }) : t('workspace.fit')}>{t('workspace.fit')}</button>
        <button type="button" className="tool-button" onClick={setActualSize}>{t('workspace.actualSize')}</button>
        <button type="button" className="tool-button icon-button" onClick={() => zoom(scale / 1.25)} aria-label={t('workspace.zoomOut')}>−</button>
        <output aria-live="polite">{Math.round(scale * (rawFrame ? dpr : 1) * 100)}%</output>
        <button type="button" className="tool-button icon-button" onClick={() => zoom(scale * 1.25)} aria-label={t('workspace.zoomIn')}>+</button>
      </div>
      <div className="viewer-toolbar-right">
        {onCopyAdjustments && onPasteAdjustments && onSelectCopyAdjustments && onSelectPasteAdjustments && <EditSettingsMenu
          disabled={editClipboardDisabled} hasClipboard={hasEditClipboard}
          onCopy={onCopyAdjustments} onPaste={onPasteAdjustments}
          onSelectCopy={onSelectCopyAdjustments} onSelectPaste={onSelectPasteAdjustments}
          contextPosition={contextMenuPosition} onContextClose={closeContextMenu}
          onMenuOpen={() => setContextMenuPosition(null)} closeMenuSignal={closeToolbarMenuSignal} />}
        {originalStatus && <>
          <button type="button" className="tool-button before-after-controls" aria-label={t('workspace.previewOriginal')}
            title={shortcut.title(t('workspace.previewOriginal'), 'viewerOriginal')}
            aria-pressed={showingOriginal} disabled={originalStatus !== 'ready' || !editSource}
            onClick={onOriginalToggle}>
            <span className={!showingOriginal ? 'active' : undefined}>{t('workspace.preview')}</span>
            <span className={showingOriginal ? 'active' : undefined}>{t('workspace.original')}</span>
          </button>
          {originalStatus !== 'ready' && <span role="status" className={originalStatus === 'error' ? 'error-text' : undefined}>
            {t(originalStatus === 'loading' ? 'workspace.originalLoading' : 'workspace.originalFailed')}
          </span>}
        </>}
        <button type="button" className="tool-button before-after-controls" aria-label={t('workspace.beforeAfter')}
          disabled={!beforeAvailable}
          title={beforeShortcut ? t('workspace.beforeHoldShortcutHint', { shortcut: beforeShortcut }) : t('workspace.beforeAfter')}
          aria-pressed={showBeforeAdjustments} aria-description={t(showBeforeAdjustments ? 'workspace.before' : 'workspace.after')}
          onClick={() => onBeforeAdjustmentsChange?.(!persistentBeforeAdjustments)}>
          <span className={showBeforeAdjustments ? 'active' : undefined}>{t('workspace.before')}</span>
          <span className={!showBeforeAdjustments ? 'active' : undefined}>{t('workspace.after')}</span>
        </button>
        <button type="button" className="tool-button icon-button panel-toggle right" onClick={onToggleRight}
          aria-label={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')}
          title={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')} aria-pressed={rightOpen}>
          <span aria-hidden="true">{rightOpen ? '›' : '‹'}</span>
        </button>
      </div>
    </div>
    <div
      ref={viewportRef}
      tabIndex={0}
      aria-label={alt}
      className={`viewer-viewport${scale > fitScale ? ' pannable' : ''}`}
      onKeyDown={(event) => {
        // Only actual photo focus participates; hovering a slider does not.
        if (keyboardBlocked || document.activeElement !== event.currentTarget || event.target !== event.currentTarget || isNativeEditingTarget(event.target)) return;
        if (!event.defaultPrevented && !event.nativeEvent.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey
          && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
          && onCopyAdjustments && onPasteAdjustments && onSelectCopyAdjustments && onSelectPasteAdjustments) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setCloseToolbarMenuSignal((current) => current + 1);
          setContextMenuPosition({ x: bounds.left, y: bounds.top, keyboard: true });
          return;
        }
        const selection = editSelectionShortcut(event.nativeEvent);
        if (selection) {
          const handled = selection === 'copy' ? onSelectCopyAdjustments?.() : onSelectPasteAdjustments?.();
          if (handled) event.preventDefault();
          return;
        }
        const shortcut = editClipboardShortcut(event.nativeEvent);
        // Let the page copy the slider currently targeted by adjustment controls.
        if (shortcut === 'copy' && activeAdjustmentId()) return;
        const handled = shortcut === 'copy' ? onCopyAdjustments?.()
          : shortcut === 'paste' ? onPasteAdjustments?.() : false;
        if (handled) event.preventDefault();
      }}
      onWheel={handleWheel}
      onContextMenu={openContextMenu}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      <div className="viewer-image-position" style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}
        onPointerDown={(event) => {
          if (event.button === 0) viewportRef.current?.focus({ preventScroll: true });
        }}>
        {editSource && recipe ? <AdjustedImage gpuRenderer={gpuRenderer} onGpuError={onGpuError} onBackendChange={onBackendChange} source={editSource} recipe={recipe} alt={alt} showBeforeAdjustments={showBeforeAdjustments}
          width={imageSize.x * scale} onHistogramChange={onHistogramChange}
          onLoad={(width, height) => { setLoadedImage({ identity: imageIdentity, status: 'ready', size: { x: width, y: height } }); }}
          onError={() => { setLoadedImage({ identity: imageIdentity, status: 'error', size: EMPTY_IMAGE_SIZE }); onImageError?.(); }} /> : src && !previewStatus ? <img
          src={showBeforeAdjustments && beforeSrc ? beforeSrc : src}
          alt={alt}
          draggable="false"
          style={{ width: imageSize.x ? `${imageSize.x * scale}px` : undefined,
            height: rawFrame ? `${imageSize.y * scale}px` : undefined }}
          onLoad={(event) => {
            setLoadedImage({ identity: imageIdentity, status: 'ready', size: {
              x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight,
            } });
          }}
          onError={() => setLoadedImage({ identity: imageIdentity, status: 'error', size: EMPTY_IMAGE_SIZE })}
        /> : null}
      </div>
      {statusNote && !(previewPixels && showBeforeAdjustments && !editSource && !beforeSrc) && <p className="raw-preview-note" role="status">{statusNote}</p>}
      {previewPixels && showBeforeAdjustments && !editSource && !beforeSrc && <p className="raw-preview-note" role="status">
        {t(beforeStatus === 'error' ? 'workspace.rawPreview.beforeFailed' : 'workspace.rawPreview.beforeLoading')}
        {beforeStatus === 'error' && onBeforeRetry && <button type="button" className="tool-button" onClick={onBeforeRetry}>
          {t('workspace.rawPreview.beforeRetry')}</button>}
      </p>}
      {(previewStatus || imageState !== 'ready') && <p className={`viewer-image-status${(previewStatus ?? imageState) === 'error' ? ' error-text' : ''}`}>
        {t((previewStatus ?? imageState) === 'error' ? 'workspace.previewFailed' : 'workspace.loading')}
      </p>}
    </div>
  </section>;
}
