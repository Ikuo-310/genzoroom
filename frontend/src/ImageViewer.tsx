import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampZoom, zoomAroundPoint, type Point } from './viewerMath';
import { AdjustedImage } from './AdjustedImage';
import { activeAdjustmentId } from './adjustmentFocus';
import { editClipboardShortcut, editSelectionShortcut, isNativeEditingTarget } from './editShortcuts';
import { EditSettingsMenu } from './EditSettingsMenu';
import type { EditRecipe } from './editing';
import type { EditImageSource } from './editImageSource';
import type { HistogramChangeHandler } from './histogram';

type ImageViewerProps = {
  src: string;
  editSource?: EditImageSource;
  originalStatus?: 'loading' | 'ready' | 'error';
  showingOriginal?: boolean;
  onOriginalToggle?: () => void;
  onImageError?: () => void;
  recipe?: EditRecipe;
  onHistogramChange?: HistogramChangeHandler;
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

export function ImageViewer({ src, editSource, originalStatus, showingOriginal = false, onOriginalToggle, onImageError, recipe, onHistogramChange, alt, leftOpen, rightOpen, persistentBeforeAdjustments = false, onBeforeAdjustmentsChange, onBeforeAdjustmentsDisplayChange, onToggleLeft, onToggleRight, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments, editClipboardDisabled = true, hasEditClipboard = false, keyboardBlocked = false }: ImageViewerProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number; keyboard?: boolean } | null>(null);
  const [closeToolbarMenuSignal, setCloseToolbarMenuSignal] = useState(0);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  const [imageSize, setImageSize] = useState<Point>({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [backslashHeld, setBackslashHeld] = useState(false);
  const showBeforeAdjustments = persistentBeforeAdjustments || backslashHeld;
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
      if (event.code === 'Backslash') {
        event.preventDefault();
        if (!event.repeat) setBackslashHeld(true);
      } else if (event.key === ']' && originalStatus === 'ready' && editSource && onOriginalToggle) {
        event.preventDefault();
        if (!event.repeat) onOriginalToggle();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === 'Backslash') setBackslashHeld(false);
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
  }, [editSource, keyboardBlocked, onOriginalToggle, originalStatus]);

  useEffect(() => {
    setImageState('loading');
    setImageSize({ x: 0, y: 0 });
    setFitMode(true);
    setPan({ x: 0, y: 0 });
  }, [src, editSource?.kind, editSource?.url]);

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
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitMode, imageSize]);

  function fit() {
    setFitMode(true);
    setScale(fitScale);
    setPan({ x: 0, y: 0 });
  }

  function setActualSize() {
    setFitMode(false);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function zoom(nextValue: number, point: Point = { x: 0, y: 0 }) {
    const next = clampZoom(nextValue);
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
        <button type="button" className="tool-button" onClick={fit}>{t('workspace.fit')}</button>
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
        {editSource && recipe ? <AdjustedImage source={editSource} recipe={recipe} alt={alt} showBeforeAdjustments={showBeforeAdjustments}
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
      {imageState !== 'ready' && <p className={`viewer-image-status${imageState === 'error' ? ' error-text' : ''}`}>
        {t(imageState === 'error' ? 'workspace.previewFailed' : 'workspace.loading')}
      </p>}
    </div>
  </section>;
}
