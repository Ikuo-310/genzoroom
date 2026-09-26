import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampZoom, zoomAroundPoint, type Point } from './viewerMath';
import { AdjustedImage } from './AdjustedImage';
import { activeAdjustmentId } from './AdjustmentSlider';
import { editClipboardShortcut, editSelectionShortcut, isNativeEditingTarget } from './editShortcuts';
import { EditSettingsMenu } from './EditSettingsMenu';
import type { EditRecipe } from './editing';
import type { EditImageSource } from './editImageSource';

type ImageViewerProps = {
  src: string;
  editSource?: EditImageSource;
  recipe?: EditRecipe;
  alt: string;
  leftOpen: boolean;
  rightOpen: boolean;
  persistentBeforeAdjustments?: boolean;
  onBeforeAdjustmentsChange?: (value: boolean) => void;
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

export function ImageViewer({ src, editSource, recipe, alt, leftOpen, rightOpen, persistentBeforeAdjustments = false, onBeforeAdjustmentsChange, onToggleLeft, onToggleRight, onCopyAdjustments, onPasteAdjustments, onSelectCopyAdjustments, onSelectPasteAdjustments, editClipboardDisabled = true, hasEditClipboard = false, keyboardBlocked = false }: ImageViewerProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  const [imageSize, setImageSize] = useState<Point>({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [backslashHeld, setBackslashHeld] = useState(false);
  const showBeforeAdjustments = persistentBeforeAdjustments || backslashHeld;

  useEffect(() => {
    if (keyboardBlocked) setBackslashHeld(false);
    const keydown = (event: KeyboardEvent) => {
      if (keyboardBlocked || event.code !== 'Backslash' || event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey || isNativeEditingTarget(event.target)) return;
      event.preventDefault();
      if (!event.repeat) setBackslashHeld(true);
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
  }, [keyboardBlocked]);

  useEffect(() => {
    setImageState('loading');
    setImageSize({ x: 0, y: 0 });
    setFitMode(true);
    setPan({ x: 0, y: 0 });
  }, [src]);

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
      <button type="button" className="tool-button panel-toggle" onClick={onToggleLeft} aria-label={t(leftOpen ? 'workspace.collapseLeft' : 'workspace.expandLeft')} aria-pressed={leftOpen}>
        {leftOpen ? '‹' : '›'} <span>{t('workspace.history')}</span>
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
          onSelectCopy={onSelectCopyAdjustments} onSelectPaste={onSelectPasteAdjustments} />}
        <div className="before-after-controls" role="group" aria-label={t('workspace.beforeAfter')}>
          <button type="button" className="tool-button" aria-pressed={showBeforeAdjustments}
            onClick={() => onBeforeAdjustmentsChange?.(true)}>{t('workspace.before')}</button>
          <button type="button" className="tool-button" aria-pressed={!showBeforeAdjustments}
            onClick={() => onBeforeAdjustmentsChange?.(false)}>{t('workspace.after')}</button>
        </div>
        <button type="button" className="tool-button panel-toggle right" onClick={onToggleRight} aria-label={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')} aria-pressed={rightOpen}>
          <span>{t('workspace.developControls')}</span> {rightOpen ? '›' : '‹'}
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
          width={imageSize.x * scale}
          onLoad={(width, height) => { setImageState('ready'); setImageSize({ x: width, y: height }); }}
          onError={() => setImageState('error')} /> : <img
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
