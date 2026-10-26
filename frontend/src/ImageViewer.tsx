import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampViewerPan, clampZoom, panForCenteredZoom, zoomAroundPoint, type Point } from './viewerMath';
import { AdjustedImage } from './AdjustedImage';
import { activeAdjustmentId } from './adjustmentFocus';
import { editClipboardShortcut, editSelectionShortcut, isNativeEditingTarget, matchesShortcut, matchesShortcutKey } from './editShortcuts';
import { EditSettingsMenu } from './EditSettingsMenu';
import { useShortcutDisplay } from './useShortcutDisplay';
import { useAppSettings } from './appSettings';
import type { EditRecipe } from './editing';
import type { EditImageSource } from './editImageSource';
import type { WorkspaceGpuRenderer, ProcessingBackend } from './useWorkspaceGpu';
import type { HistogramChangeHandler } from './histogram';

type ImageViewerProps = {
  src: string;
  editSource?: EditImageSource;
  originalStatus?: 'loading' | 'ready' | 'error';
  showingOriginal?: boolean;
  onOriginalToggle?: () => void;
  onImageError?: () => void;
  onInteractionStart?: () => void;
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

const NAVIGATOR_LONG_EDGE = 180;

export function ImageViewer({ src, editSource, originalStatus, showingOriginal = false, onOriginalToggle, onImageError, onInteractionStart, recipe, onHistogramChange, gpuRenderer, onGpuError, onBackendChange, alt, leftOpen, rightOpen, persistentBeforeAdjustments = false, onBeforeAdjustmentsChange, onBeforeAdjustmentsDisplayChange, onToggleLeft, onToggleRight, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments, editClipboardDisabled = true, hasEditClipboard = false, keyboardBlocked = false }: ImageViewerProps) {
  const { t } = useTranslation();
  const settings = useAppSettings();
  const shortcut = useShortcutDisplay();
  const beforeShortcut = shortcut.label('viewerBefore');
  const fitShortcut = shortcut.label('viewerFitRestore');
  const viewportRef = useRef<HTMLDivElement>(null);
  const imagePositionRef = useRef<HTMLDivElement>(null);
  const navigatorCanvasRef = useRef<HTMLCanvasElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number; keyboard?: boolean } | null>(null);
  const [closeToolbarMenuSignal, setCloseToolbarMenuSignal] = useState(0);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  const panMovedRef = useRef(false);
  const suppressDoubleClickRef = useRef(false);
  const suppressDoubleClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigatorDragRef = useRef<{ pointerId: number; offset: Point; frame: Point } | null>(null);
  const suppressNavigatorClickRef = useRef(false);
  const [navigatorCanvasRevision, setNavigatorCanvasRevision] = useState(0);
  const [navigatorDragging, setNavigatorDragging] = useState(false);
  const [imageSize, setImageSize] = useState<Point>({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState<Point>({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const previousTransform = useRef<{ scale: number; pan: Point } | null>(null);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const notifyNavigatorCanvasRendered = useCallback(() => setNavigatorCanvasRevision(revision => revision + 1), []);
  const zoomed = scale > fitScale;
  const navigatorScale = imageSize.x > 0 && imageSize.y > 0
    ? Math.min(NAVIGATOR_LONG_EDGE / Math.max(imageSize.x, imageSize.y),
      (viewportSize.x - 24) / imageSize.x, (viewportSize.y - 24) / imageSize.y)
    : 0;
  const showNavigator = zoomed && settings.zoomNavigatorPosition !== 'off' && imageState === 'ready'
    && viewportSize.x > 24 && viewportSize.y > 24 && navigatorScale > 0;
  const navigatorWidth = imageSize.x * navigatorScale;
  const navigatorHeight = imageSize.y * navigatorScale;
  const navigatorFrame = (() => {
    if (!imageSize.x || !imageSize.y || !scale) return { left: 0, top: 0, width: 0, height: 0 };
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
    const left = clamp(imageSize.x / 2 - (viewportSize.x / 2 + pan.x) / scale, imageSize.x);
    const right = Math.max(left, clamp(imageSize.x / 2 + (viewportSize.x / 2 - pan.x) / scale, imageSize.x));
    const top = clamp(imageSize.y / 2 - (viewportSize.y / 2 + pan.y) / scale, imageSize.y);
    const bottom = Math.max(top, clamp(imageSize.y / 2 + (viewportSize.y / 2 - pan.y) / scale, imageSize.y));
    return { left: left / imageSize.x * 100, top: top / imageSize.y * 100,
      width: (right - left) / imageSize.x * 100, height: (bottom - top) / imageSize.y * 100 };
  })();
  const [backslashHeld, setBackslashHeld] = useState(false);
  const showBeforeAdjustments = persistentBeforeAdjustments || backslashHeld;
  useLayoutEffect(() => {
    onBeforeAdjustmentsDisplayChange?.(showBeforeAdjustments);
  }, [showBeforeAdjustments, onBeforeAdjustmentsDisplayChange]);
  useLayoutEffect(() => {
    if (!showNavigator || !editSource || !recipe) return;
    const sourceCanvas = viewportRef.current?.querySelector<HTMLCanvasElement>(
      `.viewer-comparison-image canvas:${showBeforeAdjustments ? 'first-child' : 'last-child'}`);
    const targetCanvas = navigatorCanvasRef.current;
    if (!sourceCanvas || !targetCanvas || !sourceCanvas.width || !sourceCanvas.height) return;
    targetCanvas.width = Math.max(1, Math.round(navigatorWidth));
    targetCanvas.height = Math.max(1, Math.round(navigatorHeight));
    const context = targetCanvas.getContext('2d');
    if (context) context.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
  }, [showNavigator, editSource, recipe, showBeforeAdjustments, navigatorWidth, navigatorHeight, navigatorCanvasRevision]);
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
          if (!event.repeat) { onInteractionStart?.(); onOriginalToggle(); }
        } else if (matchesShortcut(event, 'viewerBefore')) {
          event.preventDefault();
        }
      } else if (matchesShortcut(event, 'viewerBefore')) {
        event.preventDefault();
        if (!event.repeat) { onInteractionStart?.(); setBackslashHeld(true); }
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
  }, [editSource, keyboardBlocked, onInteractionStart, onOriginalToggle, originalStatus]);

  useEffect(() => {
    setImageState('loading');
    setImageSize({ x: 0, y: 0 });
    setFitMode(true);
    setPan({ x: 0, y: 0 });
    previousTransform.current = null;
    panMovedRef.current = false;
    suppressDoubleClickRef.current = false;
    clearTimeout(suppressDoubleClickTimer.current);
  }, [src, editSource?.kind, editSource?.url]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || imageSize.x === 0) return;
    const updateFit = () => {
      const nextViewport = { x: viewport.clientWidth, y: viewport.clientHeight };
      setViewportSize(current => current.x === nextViewport.x && current.y === nextViewport.y ? current : nextViewport);
      const next = calculateFitScale(
        nextViewport,
        imageSize,
      );
      setFitScale(next);
      if (fitMode) {
        setScale(next);
        setPan({ x: 0, y: 0 });
      } else setPan(current => clampViewerPan(current, scale, imageSize, nextViewport));
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitMode, imageSize, scale]);

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
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function toggleFitActualSize(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || imageState !== 'ready' || !imageSize.x || !imageSize.y || dragRef.current) return;
    if (suppressDoubleClickRef.current) {
      suppressDoubleClickRef.current = false;
      clearTimeout(suppressDoubleClickTimer.current);
      return;
    }
    const viewport = viewportRef.current;
    const imagePosition = imagePositionRef.current;
    if (!viewport || !imagePosition) return;
    // Pointer capture may retarget dblclick to the viewport, so accept only points still inside the image.
    const imageBounds = imagePosition.getBoundingClientRect();
    if (event.clientX < imageBounds.left || event.clientX > imageBounds.right
      || event.clientY < imageBounds.top || event.clientY > imageBounds.bottom) return;
    if (!fitMode) {
      previousTransform.current = null;
      setFitMode(true);
      setScale(fitScale);
      setPan({ x: 0, y: 0 });
      return;
    }
    const viewportBounds = viewport.getBoundingClientRect();
    const point = { x: event.clientX - viewportBounds.left - viewportBounds.width / 2,
      y: event.clientY - viewportBounds.top - viewportBounds.height / 2 };
    const nextPan = panForCenteredZoom(pan, point, scale, 1);
    previousTransform.current = null;
    setFitMode(false);
    setScale(1);
    setPan(clampViewerPan(nextPan, 1, imageSize, { x: viewport.clientWidth, y: viewport.clientHeight }));
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (keyboardBlocked || event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target) || !matchesShortcut(event, 'viewerFitRestore')
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      event.preventDefault();
      onInteractionStart?.();
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
  }, [keyboardBlocked, fitMode, scale, pan, fitScale, onInteractionStart]);

  function zoom(nextValue: number, point: Point = { x: 0, y: 0 }) {
    const next = clampZoom(nextValue);
    setFitMode(false);
    setPan((current) => clampViewerPan(zoomAroundPoint(current, point, scale, next), next, imageSize,
      viewportSize.x && viewportSize.y ? viewportSize : { x: viewportRef.current?.clientWidth ?? 0, y: viewportRef.current?.clientHeight ?? 0 }));
    setScale(next);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (imageSize.x === 0) return;
    event.preventDefault();
    onInteractionStart?.();
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
    zoom(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), point);
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 0) panMovedRef.current = false;
    if (scale <= fitScale || event.button !== 0) return;
    onInteractionStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, pan };
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - drag.origin.x, y: event.clientY - drag.origin.y };
    // Preserve pointer-following Pan while requiring intentional movement to suppress a double-click.
    if (Math.hypot(delta.x, delta.y) >= 4) panMovedRef.current = true;
    setPan(clampViewerPan({ x: drag.pan.x + delta.x, y: drag.pan.y + delta.y }, scale, imageSize, viewportSize));
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // Pointer capture can retarget the browser's double-click sequence to the viewport after a real drag.
    if (event.type === 'pointerup' && panMovedRef.current) {
      suppressDoubleClickRef.current = true;
      clearTimeout(suppressDoubleClickTimer.current);
      suppressDoubleClickTimer.current = setTimeout(() => { suppressDoubleClickRef.current = false; }, 500);
    }
  }

  function navigatorPoint(navigator: HTMLDivElement, clientX: number, clientY: number): Point | null {
    const image = navigator.querySelector<HTMLImageElement | HTMLCanvasElement>('img, canvas');
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return { x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)) };
  }

  function setPanFromNavigatorCenter(center: Point) {
    setPan(clampViewerPan({ x: (0.5 - center.x) * imageSize.x * scale,
      y: (0.5 - center.y) * imageSize.y * scale }, scale, imageSize, viewportSize));
  }

  function startNavigatorPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.button !== 0) return;
    suppressNavigatorClickRef.current = false;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.viewer-navigator-frame')) return;
    const point = navigatorPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const frame = { x: navigatorFrame.width / 100, y: navigatorFrame.height / 100 };
    const left = navigatorFrame.left / 100, top = navigatorFrame.top / 100;
    navigatorDragRef.current = { pointerId: event.pointerId,
      offset: { x: Math.max(0, Math.min(frame.x, point.x - left)), y: Math.max(0, Math.min(frame.y, point.y - top)) }, frame };
    setNavigatorDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveNavigatorPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const drag = navigatorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = navigatorPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const left = Math.max(0, Math.min(1 - drag.frame.x, point.x - drag.offset.x));
    const top = Math.max(0, Math.min(1 - drag.frame.y, point.y - drag.offset.y));
    setPanFromNavigatorCenter({ x: left + drag.frame.x / 2, y: top + drag.frame.y / 2 });
  }

  function stopNavigatorPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const drag = navigatorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    navigatorDragRef.current = null;
    setNavigatorDragging(false);
    // Pointer cancellation has no trailing click to consume and must leave the next click available.
    if (event.type === 'pointerup') suppressNavigatorClickRef.current = true;
  }

  function clickNavigator(event: ReactMouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (suppressNavigatorClickRef.current) {
      suppressNavigatorClickRef.current = false;
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.viewer-navigator-frame')) return;
    const point = navigatorPoint(event.currentTarget, event.clientX, event.clientY);
    if (point) setPanFromNavigatorCenter(point);
  }

  return <section className="viewer-panel" aria-label={t('workspace.viewer')}
    onPointerDownCapture={() => onInteractionStart?.()} onClickCapture={() => onInteractionStart?.()}>
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
        <output aria-live="polite">{Math.round(scale * 100)}%</output>
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
      onDoubleClick={toggleFitActualSize}
      onContextMenu={openContextMenu}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      <div ref={imagePositionRef} className="viewer-image-position" style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}
        onPointerDown={(event) => {
          if (event.button === 0) viewportRef.current?.focus({ preventScroll: true });
        }}>
        {editSource && recipe ? <AdjustedImage gpuRenderer={gpuRenderer} onGpuError={onGpuError} onBackendChange={onBackendChange}
          onCanvasRendered={notifyNavigatorCanvasRendered} source={editSource} recipe={recipe} alt={alt} showBeforeAdjustments={showBeforeAdjustments}
          width={imageSize.x * scale} onHistogramChange={onHistogramChange}
          onLoad={(width, height) => { setImageState('ready'); setImageSize({ x: width, y: height }); }}
          onError={() => { setImageState('error'); onImageError?.(); }} /> : <img
          src={src}
          alt={alt}
          draggable="false"
          style={{ width: imageSize.x ? `${imageSize.x * scale}px` : undefined }}
          onLoad={(event) => {
            setImageState('ready');
            setImageSize({ x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight });
          }}
          onError={() => setImageState('error')}
        />}
      </div>
      {showNavigator && <div className={`viewer-navigator${navigatorDragging ? ' dragging' : ''}`} data-testid="zoom-navigator"
        data-position={settings.zoomNavigatorPosition} style={{ width: navigatorWidth, height: navigatorHeight }}
        aria-hidden="true" onClick={clickNavigator} onPointerDown={startNavigatorPointer}
        onPointerMove={moveNavigatorPointer} onPointerUp={stopNavigatorPointer}
        onPointerCancel={stopNavigatorPointer} onWheel={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
        {editSource && recipe ? <canvas ref={navigatorCanvasRef} aria-hidden="true"
          width={Math.max(1, Math.round(navigatorWidth))} height={Math.max(1, Math.round(navigatorHeight))} />
          : <img src={src} alt="" draggable="false" />}
        <div className="viewer-navigator-frame" style={{ left: `${navigatorFrame.left}%`, top: `${navigatorFrame.top}%`,
          width: `${navigatorFrame.width}%`, height: `${navigatorFrame.height}%` }} />
      </div>}
      {imageState !== 'ready' && <p className={`viewer-image-status${imageState === 'error' ? ' error-text' : ''}`}>
        {t(imageState === 'error' ? 'workspace.previewFailed' : 'workspace.loading')}
      </p>}
    </div>
  </section>;
}
