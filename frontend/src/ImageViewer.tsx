import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampZoom, zoomAroundPoint, type Point } from './viewerMath';
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
import type { RawView } from './rawWholePreview';
import type { RawRegionDisplay } from './rawRegionOverlay';

type ImageViewerProps = {
  src: string;
  documentKey?: string;
  rawFrame?: { nativeWidth: number; nativeHeight: number; geometryId: string };
  rawRegionDisplay?: RawRegionDisplay;
  rawRegionOutline?: boolean;
  onRawViewChange?: (view: RawView) => void;
  rawDiagnosticView?: { actual: boolean; nativePanX: number; nativePanY: number };
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
const NAVIGATOR_LONG_EDGE = 180;

function clampViewerPan(pan: Point, scale: number, imageSize: Point, viewportSize: Point): Point {
  const maxX = Math.max(0, (imageSize.x * scale - viewportSize.x) / 2);
  const maxY = Math.max(0, (imageSize.y * scale - viewportSize.y) / 2);
  return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) };
}

export function ImageViewer({ src, documentKey, rawFrame, rawRegionDisplay, rawRegionOutline = false, onRawViewChange, rawDiagnosticView, previewStatus, statusNote, previewPixels = false, beforeAvailable = true, beforeSrc, beforeStatus, onBeforeRetry, editSource, originalStatus, showingOriginal = false, onOriginalToggle, onImageError, recipe, onHistogramChange, gpuRenderer, onGpuError, onBackendChange, alt, leftOpen, rightOpen, persistentBeforeAdjustments = false, onBeforeAdjustmentsChange, onBeforeAdjustmentsDisplayChange, onToggleLeft, onToggleRight, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments, editClipboardDisabled = true, hasEditClipboard = false, keyboardBlocked = false }: ImageViewerProps) {
  const { t } = useTranslation();
  const settings = useAppSettings();
  const shortcut = useShortcutDisplay();
  const beforeShortcut = shortcut.label('viewerBefore');
  const fitShortcut = shortcut.label('viewerFitRestore');
  const viewportRef = useRef<HTMLDivElement>(null);
  const imagePositionRef = useRef<HTMLDivElement>(null);
  const imageIdentity = documentKey ?? `${src}:${editSource?.kind ?? ''}:${editSource?.url ?? ''}`;
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number; keyboard?: boolean } | null>(null);
  const [closeToolbarMenuSignal, setCloseToolbarMenuSignal] = useState(0);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  const panMovedRef = useRef(false);
  const suppressDoubleClickRef = useRef(false);
  const suppressDoubleClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
  const [viewportSize, setViewportSize] = useState({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const zoomed = scale > fitScale;
  const navigatorPosition = settings.zoomNavigatorPosition;
  const navigatorScale = imageSize.x > 0 && imageSize.y > 0
    ? Math.min(NAVIGATOR_LONG_EDGE / Math.max(imageSize.x, imageSize.y), (viewportSize.x - 24) / imageSize.x, (viewportSize.y - 24) / imageSize.y) : 0;
  const showNavigator = zoomed && navigatorPosition !== 'off' && imageState === 'ready'
    && viewportSize.x > 24 && viewportSize.y > 24 && navigatorScale > 0;
  const navigatorWidth = imageSize.x * navigatorScale;
  const navigatorHeight = imageSize.y * navigatorScale;
  const navigatorFrame = useMemo(() => {
    if (!imageSize.x || !imageSize.y || !scale) return { left: 0, top: 0, width: 0, height: 0 };
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
    const left = clamp(imageSize.x / 2 - (viewportSize.x / 2 + pan.x) / scale, imageSize.x);
    const right = Math.max(left, clamp(imageSize.x / 2 + (viewportSize.x / 2 - pan.x) / scale, imageSize.x));
    const top = clamp(imageSize.y / 2 - (viewportSize.y / 2 + pan.y) / scale, imageSize.y);
    const bottom = Math.max(top, clamp(imageSize.y / 2 + (viewportSize.y / 2 - pan.y) / scale, imageSize.y));
    return { left: left / imageSize.x * 100, top: top / imageSize.y * 100,
      width: (right - left) / imageSize.x * 100, height: (bottom - top) / imageSize.y * 100 };
  }, [imageSize.x, imageSize.y, scale, pan.x, pan.y, viewportSize.x, viewportSize.y]);
  const navigatorCanvasRef = useRef<HTMLCanvasElement>(null);
  const navigatorDragRef = useRef<{ pointerId: number; offset: Point; frame: Point } | null>(null);
  const suppressNavigatorClickRef = useRef(false);
  const navigatorVisibleRef = useRef(showNavigator);
  navigatorVisibleRef.current = showNavigator;
  const [navigatorCanvasRevision, setNavigatorCanvasRevision] = useState(0);
  const notifyNavigatorCanvasRendered = useCallback(() => {
    if (navigatorVisibleRef.current) setNavigatorCanvasRevision(revision => revision + 1);
  }, []);
  const previousTransform = useRef<{ scale: number; pan: Point } | null>(null);
  const [viewInteracting, setViewInteracting] = useState(false);
  const viewGestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setViewInteracting(false);
    suppressDoubleClickRef.current = false;
    return () => {
      clearTimeout(viewGestureTimer.current);
      clearTimeout(suppressDoubleClickTimer.current);
    };
  }, [imageIdentity]);
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
  useEffect(() => {
    if (rawFrame) viewCallback.current?.({ width: viewportSize.x, height: viewportSize.y, dpr, scale,
      nativeWidth: rawFrame.nativeWidth, nativeHeight: rawFrame.nativeHeight, geometryId: rawFrame.geometryId, fit: fitMode,
      panX: pan.x, panY: pan.y, interacting: viewInteracting });
  }, [scale, dpr, rawFrame?.geometryId, rawFrame?.nativeWidth, rawFrame?.nativeHeight, viewportSize.x, viewportSize.y, fitMode, pan.x, pan.y, viewInteracting]);
  const [backslashHeld, setBackslashHeld] = useState(false);
  const showBeforeAdjustments = beforeAvailable && (persistentBeforeAdjustments || backslashHeld);
  const regionDisplay = rawRegionDisplay?.after.metadata.geometryId === rawFrame?.geometryId
    && (!showBeforeAdjustments || !!rawRegionDisplay?.before && !!rawRegionDisplay.wholeBefore) ? rawRegionDisplay : undefined;
  const regionLayer = showBeforeAdjustments ? regionDisplay?.before : regionDisplay?.after;
  const regionBase = showBeforeAdjustments ? regionDisplay?.wholeBefore : regionDisplay?.wholeAfter;
  const navigatorImageSrc = regionBase?.url ?? (showBeforeAdjustments && beforeSrc ? beforeSrc : src);
  useLayoutEffect(() => {
    onBeforeAdjustmentsDisplayChange?.(showBeforeAdjustments);
  }, [showBeforeAdjustments, onBeforeAdjustmentsDisplayChange]);
  useLayoutEffect(() => {
    if (!showNavigator || !editSource || !recipe) return;
    // Both source canvases remain visible in After mode, so mirror the topmost active comparison side.
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
      setViewportSize(current => current.x === viewport.clientWidth && current.y === viewport.clientHeight
        ? current : { x: viewport.clientWidth, y: viewport.clientHeight });
      const next = calculateFitScale(
        { x: viewport.clientWidth, y: viewport.clientHeight },
        imageSize,
      );
      setFitScale(next);
      if (fitMode) {
        setScale(next);
        setPan({ x: 0, y: 0 });
      }
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
    clearTimeout(viewGestureTimer.current); setViewInteracting(false);
    previousTransform.current = null;
    setFitMode(true);
    setScale(fitScale);
    setPan({ x: 0, y: 0 });
  }

  function setActualSize() {
    clearTimeout(viewGestureTimer.current); setViewInteracting(false);
    previousTransform.current = null;
    setFitMode(false);
    setScale(rawFrame ? 1 / dpr : 1);
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
    const imageBounds = imagePosition.getBoundingClientRect();
    if (event.clientX < imageBounds.left || event.clientX > imageBounds.right
      || event.clientY < imageBounds.top || event.clientY > imageBounds.bottom) return;

    clearTimeout(viewGestureTimer.current);
    setViewInteracting(false);
    previousTransform.current = null;
    if (!fitMode) {
      setFitMode(true);
      setScale(fitScale);
      setPan({ x: 0, y: 0 });
      return;
    }

    const nextScale = rawFrame ? 1 / dpr : 1;
    const bounds = viewport.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
    const nextPan = zoomAroundPoint(pan, point, scale, nextScale);
    setFitMode(false);
    setScale(nextScale);
    setPan(clampViewerPan(nextPan, nextScale, imageSize, { x: viewport.clientWidth, y: viewport.clientHeight }));
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
    if (rawFrame) {
      setViewInteracting(true); clearTimeout(viewGestureTimer.current);
      // C2-C provisional quiet interval; this changes display quality, never the edit/save gesture owner.
      viewGestureTimer.current = setTimeout(() => { if (!dragRef.current) setViewInteracting(false); }, 180);
    }
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
    if (event.button === 0) panMovedRef.current = false;
    if (scale <= fitScale || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, pan };
    if (rawFrame) setViewInteracting(true);
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - drag.origin.x, y: event.clientY - drag.origin.y };
    if (Math.hypot(delta.x, delta.y) >= 4) panMovedRef.current = true;
    setPan({ x: drag.pan.x + delta.x, y: drag.pan.y + delta.y });
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (panMovedRef.current) {
      // Pointer capture can retarget the trailing click sequence into a false viewport double-click.
      suppressDoubleClickRef.current = true;
      clearTimeout(suppressDoubleClickTimer.current);
      suppressDoubleClickTimer.current = setTimeout(() => { suppressDoubleClickRef.current = false; }, 500);
    }
    if (rawFrame) setViewInteracting(false);
  }

  function navigatorPoint(navigator: HTMLDivElement, clientX: number, clientY: number): Point | null {
    const image = navigator.querySelector<HTMLImageElement | HTMLCanvasElement>('img, canvas');
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return { x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)) };
  }

  function setPanFromNavigatorCenter(center: Point, dragging: boolean) {
    // Pan is the inverse offset from the normalized image point to keep it at the viewport center.
    const nextPan = clampViewerPan({ x: (0.5 - center.x) * imageSize.x * scale,
      y: (0.5 - center.y) * imageSize.y * scale }, scale, imageSize, viewportSize);
    setPan(nextPan);
    if (!rawFrame) return;
    clearTimeout(viewGestureTimer.current);
    setViewInteracting(true);
    if (!dragging) viewGestureTimer.current = setTimeout(() => {
      if (!dragRef.current && !navigatorDragRef.current) setViewInteracting(false);
    }, 180);
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
    event.currentTarget.setPointerCapture(event.pointerId);
    clearTimeout(viewGestureTimer.current);
    if (rawFrame) setViewInteracting(true);
  }

  function moveNavigatorPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const drag = navigatorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = navigatorPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const left = Math.max(0, Math.min(1 - drag.frame.x, point.x - drag.offset.x));
    const top = Math.max(0, Math.min(1 - drag.frame.y, point.y - drag.offset.y));
    setPanFromNavigatorCenter({ x: left + drag.frame.x / 2, y: top + drag.frame.y / 2 }, true);
  }

  function stopNavigatorPointer(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const drag = navigatorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    navigatorDragRef.current = null;
    // Only pointerup produces a trailing click; pointercancel ends without one.
    if (event.type === 'pointerup') suppressNavigatorClickRef.current = true;
    clearTimeout(viewGestureTimer.current);
    if (rawFrame) setViewInteracting(false);
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
    if (point) setPanFromNavigatorCenter(point, false);
  }

  useLayoutEffect(() => {
    if (!rawFrame || !rawDiagnosticView) return;
    // Diagnostics drive the same Native transform without synthesizing trusted pointer capture.
    setFitMode(!rawDiagnosticView.actual);
    setScale(rawDiagnosticView.actual ? 1 / dpr : fitScale);
    setPan({ x: rawDiagnosticView.nativePanX / dpr, y: rawDiagnosticView.nativePanY / dpr });
  }, [rawDiagnosticView?.actual, rawDiagnosticView?.nativePanX, rawDiagnosticView?.nativePanY, !!rawFrame, fitScale, dpr]);

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
      className={`viewer-viewport${zoomed ? ' pannable' : ''}`}
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
        {editSource && recipe ? <AdjustedImage gpuRenderer={gpuRenderer} onGpuError={onGpuError} onBackendChange={onBackendChange} onCanvasRendered={notifyNavigatorCanvasRendered} source={editSource} recipe={recipe} alt={alt} showBeforeAdjustments={showBeforeAdjustments}
          width={imageSize.x * scale} onHistogramChange={onHistogramChange}
          onLoad={(width, height) => { setLoadedImage({ identity: imageIdentity, status: 'ready', size: { x: width, y: height } }); }}
          onError={() => { setLoadedImage({ identity: imageIdentity, status: 'error', size: EMPTY_IMAGE_SIZE }); onImageError?.(); }} /> : src && !previewStatus && rawFrame && previewPixels ? <div
            className="raw-native-frame" style={{ position: 'relative', width: imageSize.x * scale, height: imageSize.y * scale }}>
            <img className="raw-whole-base" src={regionBase?.url ?? (showBeforeAdjustments && beforeSrc ? beforeSrc : src)} alt={alt} draggable="false"
              style={{ width: '100%', height: '100%' }} onLoad={event => setLoadedImage({ identity: imageIdentity, status: 'ready',
                size: { x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight } })}
              onError={() => setLoadedImage({ identity: imageIdentity, status: 'error', size: EMPTY_IMAGE_SIZE })} />
            {regionLayer && <img className="raw-region-overlay" src={regionLayer.url} alt="" aria-hidden="true" draggable="false"
              style={{ position: 'absolute', pointerEvents: 'none', boxShadow: 'none',
                left: regionLayer.nativePlacement.x0 * scale, top: regionLayer.nativePlacement.y0 * scale,
                width: (regionLayer.nativePlacement.x1 - regionLayer.nativePlacement.x0) * scale,
                height: (regionLayer.nativePlacement.y1 - regionLayer.nativePlacement.y0) * scale,
                clipPath: `inset(${(regionLayer.validNativeRect.y0 - regionLayer.nativePlacement.y0) * scale}px ${(regionLayer.nativePlacement.x1 - regionLayer.validNativeRect.x1) * scale}px ${(regionLayer.nativePlacement.y1 - regionLayer.validNativeRect.y1) * scale}px ${(regionLayer.validNativeRect.x0 - regionLayer.nativePlacement.x0) * scale}px)` }} />}
            {rawRegionOutline && regionLayer && <div className="raw-region-valid-outline" aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none',
              left: regionLayer.validNativeRect.x0 * scale, top: regionLayer.validNativeRect.y0 * scale,
              width: (regionLayer.validNativeRect.x1 - regionLayer.validNativeRect.x0) * scale,
              height: (regionLayer.validNativeRect.y1 - regionLayer.validNativeRect.y0) * scale,
              boxSizing: 'border-box', border: '1px solid #ff3b30' }} />}
          </div> : src && !previewStatus ? <img
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
      {showNavigator && <div className="viewer-navigator" data-testid="zoom-navigator" data-position={navigatorPosition}
        role="img" aria-label={t('workspace.zoomNavigator')} style={{ width: navigatorWidth, height: navigatorHeight }}
        onClick={clickNavigator} onPointerDown={startNavigatorPointer} onPointerMove={moveNavigatorPointer}
        onPointerUp={stopNavigatorPointer} onPointerCancel={stopNavigatorPointer}
        onWheel={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        {editSource && recipe ? <canvas ref={navigatorCanvasRef} aria-hidden="true"
          width={Math.max(1, Math.round(navigatorWidth))} height={Math.max(1, Math.round(navigatorHeight))} />
          : <img src={navigatorImageSrc} alt="" draggable="false" />}
        <div className="viewer-navigator-frame" aria-hidden="true" style={{ left: `${navigatorFrame.left}%`, top: `${navigatorFrame.top}%`,
          width: `${navigatorFrame.width}%`, height: `${navigatorFrame.height}%` }} />
      </div>}
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
