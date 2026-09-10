import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateFitScale, clampZoom, zoomAroundPoint, type Point } from './viewerMath';

type ImageViewerProps = {
  src: string;
  alt: string;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
};

export function ImageViewer({ src, alt, leftOpen, rightOpen, onToggleLeft, onToggleRight }: ImageViewerProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; origin: Point; pan: Point } | null>(null);
  const [imageSize, setImageSize] = useState<Point>({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState(true);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');

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
      <button type="button" className="tool-button panel-toggle right" onClick={onToggleRight} aria-label={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')} aria-pressed={rightOpen}>
        <span>{t('workspace.developControls')}</span> {rightOpen ? '›' : '‹'}
      </button>
    </div>
    <div
      ref={viewportRef}
      className={`viewer-viewport${scale > fitScale ? ' pannable' : ''}`}
      onWheel={handleWheel}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      <div className="viewer-image-position" style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}>
        <img
          src={src}
          alt={alt}
          draggable="false"
          style={{ width: imageSize.x ? `${imageSize.x * scale}px` : undefined }}
          onLoad={(event) => {
            setImageState('ready');
            setImageSize({ x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight });
          }}
          onError={() => setImageState('error')}
        />
      </div>
      {imageState !== 'ready' && <p className={`viewer-image-status${imageState === 'error' ? ' error-text' : ''}`}>
        {t(imageState === 'error' ? 'workspace.previewFailed' : 'workspace.loading')}
      </p>}
    </div>
  </section>;
}
