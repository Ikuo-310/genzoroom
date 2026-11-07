import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusAdjustmentCategory, navigateAdjustments } from './adjustmentFocus';
import { RAW_CURVE_CHANNELS, type RawCurveChannel, type RawCurvePoint } from './rawApi';

const channelLabels: Record<RawCurveChannel, string> = {
  master: 'RGB', red: 'R', green: 'G', blue: 'B',
};
const graphSize = 256;
const graphInset = 12;
const graphExtent = graphSize - graphInset * 2;
const pointHitRadiusPx = 10;
const minimumPointGapPx = 8;
const identityPoints: RawCurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

type CurveDraft = Record<RawCurveChannel, RawCurvePoint[]>;
type ChannelSelection = Record<RawCurveChannel, number | null>;
type CurveDrag = { pointerId: number; channel: RawCurveChannel; index: number; startPoints: RawCurvePoint[]; workingPoints: RawCurvePoint[]; captureTarget: SVGCircleElement };
export type RawCurveDragResult = { channel: RawCurveChannel; before: RawCurvePoint[]; after: RawCurvePoint[]; changed: boolean };

function copyCurve(curve: CurveDraft): CurveDraft {
  return Object.fromEntries(RAW_CURVE_CHANNELS.map(channel => [channel, curve[channel].map(point => ({ ...point }))])) as CurveDraft;
}

function svgPoint(point: RawCurvePoint) {
  return `${graphInset + point.x * graphExtent},${graphInset + (1 - point.y) * graphExtent}`;
}

function samePoints(left: RawCurvePoint[], right: RawCurvePoint[]) {
  return left.length === right.length && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}

function effectivePoints(points: RawCurvePoint[]) {
  return points.length ? points : identityPoints;
}

function pchipEndpoint(h0: number, h1: number, slope0: number, slope1: number) {
  let tangent = ((2 * h0 + h1) * slope0 - h0 * slope1) / (h0 + h1);
  if (Math.sign(tangent) !== Math.sign(slope0)) tangent = 0;
  else if (Math.sign(slope0) !== Math.sign(slope1) && Math.abs(tangent) > Math.abs(3 * slope0)) tangent = 3 * slope0;
  return tangent;
}

function smoothCurvePath(points: RawCurvePoint[]) {
  if (points.length === 0) return `M${svgPoint({ x: 0, y: 0 })} L${svgPoint({ x: 1, y: 1 })}`;
  const visualPoints = points.length === 1
    ? [...(points[0].x > 0 ? [{ x: 0, y: 0 }] : []), ...points, ...(points[0].x < 1 ? [{ x: 1, y: 1 }] : [])]
    : points;
  if (visualPoints.length === 1) return `M${svgPoint(visualPoints[0])}`;
  if (visualPoints.length === 2 || visualPoints.some((point, index) => index > 0 && point.x <= visualPoints[index - 1].x))
    return `M${svgPoint(visualPoints[0])} ${visualPoints.slice(1).map(point => `L${svgPoint(point)}`).join(' ')}`;

  // PCHIP preserves each segment's endpoint range when slopes reverse, avoiding overshoot and extra waves.
  const intervals = visualPoints.slice(1).map((point, index) => point.x - visualPoints[index].x);
  const slopes = visualPoints.slice(1).map((point, index) => (point.y - visualPoints[index].y) / intervals[index]);
  const tangents = new Array<number>(visualPoints.length);
  tangents[0] = pchipEndpoint(intervals[0], intervals[1], slopes[0], slopes[1]);
  tangents[tangents.length - 1] = pchipEndpoint(intervals[intervals.length - 1], intervals[intervals.length - 2], slopes[slopes.length - 1], slopes[slopes.length - 2]);
  for (let index = 1; index < visualPoints.length - 1; index++) {
    const before = slopes[index - 1], after = slopes[index];
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
      tangents[index] = 0;
    } else {
      const previousWidth = intervals[index - 1], nextWidth = intervals[index];
      const firstWeight = 2 * nextWidth + previousWidth;
      const secondWeight = nextWidth + 2 * previousWidth;
      tangents[index] = (firstWeight + secondWeight) / (firstWeight / before + secondWeight / after);
    }
  }

  let path = `M${svgPoint(visualPoints[0])}`;
  for (let index = 0; index < intervals.length; index++) {
    const left = visualPoints[index], right = visualPoints[index + 1], width = intervals[index];
    const firstControl = { x: left.x + width / 3, y: left.y + tangents[index] * width / 3 };
    const secondControl = { x: right.x - width / 3, y: right.y - tangents[index + 1] * width / 3 };
    path += ` C${svgPoint(firstControl)} ${svgPoint(secondControl)} ${svgPoint(right)}`;
  }
  return path;
}

export function RawPointCurveControls({ curve, onDragCommit, onPointEdit, editDisabled = false, syncKey }: {
  curve: Record<RawCurveChannel, RawCurvePoint[]>;
  onDragCommit?: (result: RawCurveDragResult) => void;
  onPointEdit?: (channel: RawCurveChannel, points: RawCurvePoint[]) => void;
  editDisabled?: boolean;
  syncKey?: unknown;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<RawCurveChannel>('master');
  const [draft, setDraft] = useState<CurveDraft>(() => copyCurve(curve));
  const [selected, setSelected] = useState<ChannelSelection>({ master: null, red: null, green: null, blue: null });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<CurveDrag | null>(null);
  const suppressClickRef = useRef(false);
  useEffect(() => {
    cancelDrag(false);
    setDraft(copyCurve(curve));
    setSelected({ master: null, red: null, green: null, blue: null });
  }, [curve, syncKey]);
  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag) releasePointerCapture(drag);
    dragRef.current = null;
  }, []);

  const points = draft[channel];
  const visiblePoints = points.length ? points : identityPoints;
  const path = smoothCurvePath(points);
  const dragPoint = dragRef.current?.workingPoints[dragRef.current.index];
  const draggingEndpoint = dragPoint?.x === 0 || dragPoint?.x === 1;

  function releasePointerCapture(drag: CurveDrag) {
    try {
      if (typeof drag.captureTarget.releasePointerCapture === 'function'
        && (typeof drag.captureTarget.hasPointerCapture !== 'function' || drag.captureTarget.hasPointerCapture(drag.pointerId)))
        drag.captureTarget.releasePointerCapture(drag.pointerId);
    } catch { /* The browser can release capture automatically when a pointer is cancelled. */ }
  }

  function cancelDrag(suppressClick = true) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    releasePointerCapture(drag);
    setDraft(previous => ({ ...previous, [drag.channel]: drag.startPoints.map(point => ({ ...point })) }));
    setSelected(previous => ({ ...previous, [drag.channel]: drag.index }));
    setDragging(false);
    suppressClickRef.current = suppressClick;
    if (suppressClick) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }

  function pointsAtPointer(drag: CurveDrag, svg: SVGSVGElement, clientX: number, clientY: number) {
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return drag.startPoints.map(point => ({ ...point }));
    const xSvg = Math.min(graphSize - graphInset, Math.max(graphInset, (clientX - bounds.left) / bounds.width * graphSize));
    const ySvg = Math.min(graphSize - graphInset, Math.max(graphInset, (clientY - bounds.top) / bounds.height * graphSize));
    const point = drag.workingPoints[drag.index];
    if (!point) return drag.startPoints.map(item => ({ ...item }));
    const nextPoint = { ...point, y: 1 - (ySvg - graphInset) / graphExtent };
    if (point.x !== 0 && point.x !== 1) {
      const previous = drag.workingPoints[drag.index - 1];
      const next = drag.workingPoints[drag.index + 1];
      const span = (next?.x ?? 1) - (previous?.x ?? 0);
      if (span <= 0) return drag.startPoints.map(item => ({ ...item }));
      const minimumGap = Math.min(minimumPointGapPx * graphSize / (bounds.width * graphExtent), span / (previous && next ? 2 : 1));
      const minimumX = (previous?.x ?? 0) + minimumGap;
      const maximumX = (next?.x ?? 1) - minimumGap;
      const requestedX = (xSvg - graphInset) / graphExtent;
      nextPoint.x = Math.min(maximumX, Math.max(minimumX, requestedX));
    }
    const nextPoints = drag.workingPoints.map(item => ({ ...item }));
    nextPoints[drag.index] = nextPoint;
    return nextPoints;
  }

  function handlePointerDown(event: ReactPointerEvent<SVGCircleElement>, index: number) {
    if (editDisabled || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    svg.focus();
    const startPoints = points.map(point => ({ ...point }));
    const workingPoints = (points.length ? points : identityPoints).map(point => ({ ...point }));
    // The frozen channel and point array keep pointer capture isolated from channel switches and P5's final diff.
    dragRef.current = { pointerId: event.pointerId, channel, index, startPoints, workingPoints, captureTarget: event.currentTarget };
    suppressClickRef.current = true;
    setSelected(previous => ({ ...previous, [channel]: index }));
    setDragging(true);
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextPoints = pointsAtPointer(drag, event.currentTarget, event.clientX, event.clientY);
    setDraft(previous => ({ ...previous, [drag.channel]: nextPoints }));
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const candidatePoints = pointsAtPointer(drag, event.currentTarget, event.clientX, event.clientY);
    const changed = !samePoints(effectivePoints(drag.startPoints), effectivePoints(candidatePoints));
    const finalPoints = changed ? candidatePoints : drag.startPoints;
    dragRef.current = null;
    releasePointerCapture(drag);
    setDraft(previous => ({ ...previous, [drag.channel]: finalPoints.map(point => ({ ...point })) }));
    setDragging(false);
    onDragCommit?.({ channel: drag.channel, before: drag.startPoints.map(point => ({ ...point })),
      after: finalPoints.map(point => ({ ...point })), changed });
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === event.pointerId) cancelDrag();
  }

  function selectPoint(index: number, materializeIdentity = false) {
    if (materializeIdentity && points.length === 0) setDraft(previous => ({ ...previous, [channel]: identityPoints.map(point => ({ ...point })) }));
    setSelected(previous => ({ ...previous, [channel]: index }));
  }

  function addOrSelectPoint(event: MouseEvent<SVGSVGElement>) {
    if (editDisabled) return;
    const svg = event.currentTarget;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const xSvg = (event.clientX - bounds.left) / bounds.width * graphSize;
    const ySvg = (event.clientY - bounds.top) / bounds.height * graphSize;
    if (xSvg < graphInset || xSvg > graphSize - graphInset || ySvg < graphInset || ySvg > graphSize - graphInset) return;
    svg.focus();
    const x = (xSvg - graphInset) / graphExtent;
    const y = 1 - (ySvg - graphInset) / graphExtent;
    const basePoints = points.length ? points : identityPoints;
    const nearestIndex = basePoints.reduce((nearest, point, index) => {
      const distance = Math.hypot(xSvg - (graphInset + point.x * graphExtent), ySvg - (graphInset + (1 - point.y) * graphExtent));
      return distance < nearest.distance ? { index, distance } : nearest;
    }, { index: -1, distance: pointHitRadiusPx * graphSize / bounds.width + Number.EPSILON });
    if (nearestIndex.index >= 0) {
      selectPoint(nearestIndex.index, points.length === 0);
      return;
    }
    const duplicateIndex = basePoints.findIndex(point => point.x === x);
    if (duplicateIndex >= 0) {
      selectPoint(duplicateIndex, points.length === 0);
      return;
    }
    const nextPoints = [...basePoints, { x, y }].sort((left, right) => left.x - right.x);
    const nextIndex = nextPoints.findIndex(point => point.x === x && point.y === y);
    setDraft(previous => ({ ...previous, [channel]: nextPoints.map(point => ({ ...point })) }));
    setSelected(previous => ({ ...previous, [channel]: nextIndex }));
    onPointEdit?.(channel, nextPoints.map(point => ({ ...point })));
  }

  function handleGraphKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape' && dragRef.current) {
      event.preventDefault();
      cancelDrag();
      return;
    }
    if (event.key === 'Delete' && document.activeElement === event.currentTarget) {
      event.preventDefault();
      if (dragRef.current) return;
      const index = selected[channel];
      if (editDisabled || index === null || points[index]?.x === 0 || points[index]?.x === 1) return;
      const nextPoints = points.filter((_, pointIndex) => pointIndex !== index);
      setDraft(previous => ({ ...previous, [channel]: nextPoints }));
      setSelected(previous => ({ ...previous, [channel]: null }));
      onPointEdit?.(channel, nextPoints.map(point => ({ ...point })));
      return;
    }
    if (event.key === 'Escape') return;
    navigateAdjustments(event.nativeEvent, event.currentTarget as unknown as HTMLElement);
  }

  function handleGraphClick(event: MouseEvent<SVGSVGElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    addOrSelectPoint(event);
  }

  return <div className="raw-point-curve-controls">
    <div className="raw-curve-channels" role="group" aria-label={t('workspace.rawPreview.curveChannels')}
      onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.target as HTMLElement)}>
      {RAW_CURVE_CHANNELS.map(item => <button key={item} type="button" className="raw-curve-channel"
        data-channel={item} aria-label={t(`workspace.rawPreview.curveChannelNames.${item}`)}
        aria-pressed={channel === item} onClick={() => { if (item !== channel) cancelDrag(); setChannel(item); }}>
        {channelLabels[item]}
      </button>)}
    </div>
    <svg className={`raw-curve-graph is-${channel}${dragging ? ` is-dragging is-dragging-${draggingEndpoint ? 'endpoint' : 'interior'}` : ''}`} viewBox={`0 0 ${graphSize} ${graphSize}`} role="img" tabIndex={0}
      aria-label={t('workspace.rawPreview.curveGraph')} data-testid="raw-curve-graph" data-channel={channel}
      onFocus={focusAdjustmentCategory} onKeyDown={handleGraphKeyDown} onClick={handleGraphClick}
      onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerCancel}>
      <rect className="raw-curve-background" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      {[0.25, 0.5, 0.75].map(fraction => <g key={fraction} className="raw-curve-grid">
        <line x1={graphInset + fraction * graphExtent} y1={graphInset} x2={graphInset + fraction * graphExtent} y2={graphSize - graphInset} />
        <line x1={graphInset} y1={graphInset + fraction * graphExtent} x2={graphSize - graphInset} y2={graphInset + fraction * graphExtent} />
      </g>)}
      <rect className="raw-curve-frame" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      <line className="raw-curve-identity" x1={graphInset} y1={graphSize - graphInset}
        x2={graphSize - graphInset} y2={graphInset} />
      <path className="raw-curve-line" data-testid="raw-curve-line" d={path} />
      {visiblePoints.map((point, index) => <circle className={`raw-curve-point${point.x === 0 || point.x === 1 ? ' is-endpoint' : ' is-interior'}${selected[channel] === index ? ' is-selected' : ''}`}
        key={`${channel}:${index}`} data-testid="raw-curve-point" data-point-index={index}
        aria-selected={selected[channel] === index} cx={graphInset + point.x * graphExtent}
        cy={graphInset + (1 - point.y) * graphExtent} r={selected[channel] === index ? 5 : 3.5}
        onPointerDown={event => handlePointerDown(event, index)} onClick={event => {
          event.stopPropagation();
          const followsPointer = suppressClickRef.current;
          suppressClickRef.current = false;
          if (followsPointer) setSelected(previous => ({ ...previous, [channel]: index }));
          else selectPoint(index, points.length === 0);
          event.currentTarget.ownerSVGElement?.focus();
        }} />)}
    </svg>
  </div>;
}
