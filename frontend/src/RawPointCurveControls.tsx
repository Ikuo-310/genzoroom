import { useEffect, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
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
const identityPoints: RawCurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

type CurveDraft = Record<RawCurveChannel, RawCurvePoint[]>;
type ChannelSelection = Record<RawCurveChannel, number | null>;

function copyCurve(curve: CurveDraft): CurveDraft {
  return Object.fromEntries(RAW_CURVE_CHANNELS.map(channel => [channel, curve[channel].map(point => ({ ...point }))])) as CurveDraft;
}

function svgPoint(point: RawCurvePoint) {
  return `${graphInset + point.x * graphExtent},${graphInset + (1 - point.y) * graphExtent}`;
}

export function RawPointCurveControls({ curve }: {
  curve: Record<RawCurveChannel, RawCurvePoint[]>;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<RawCurveChannel>('master');
  const [draft, setDraft] = useState<CurveDraft>(() => copyCurve(curve));
  const [selected, setSelected] = useState<ChannelSelection>({ master: null, red: null, green: null, blue: null });
  useEffect(() => {
    setDraft(copyCurve(curve));
    setSelected({ master: null, red: null, green: null, blue: null });
  }, [curve]);

  const points = draft[channel];
  const visiblePoints = points.length ? points : identityPoints;
  const line = points.length ? points.map(svgPoint).join(' ') : `${svgPoint({ x: 0, y: 0 })} ${svgPoint({ x: 1, y: 1 })}`;

  function selectPoint(index: number, materializeIdentity = false) {
    if (materializeIdentity && points.length === 0) setDraft(previous => ({ ...previous, [channel]: identityPoints.map(point => ({ ...point })) }));
    setSelected(previous => ({ ...previous, [channel]: index }));
  }

  function addOrSelectPoint(event: MouseEvent<SVGSVGElement>) {
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
  }

  function handleGraphKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Delete' && document.activeElement === event.currentTarget) {
      event.preventDefault();
      const index = selected[channel];
      if (index === null || points[index]?.x === 0 || points[index]?.x === 1) return;
      setDraft(previous => ({ ...previous, [channel]: previous[channel].filter((_, pointIndex) => pointIndex !== index) }));
      setSelected(previous => ({ ...previous, [channel]: null }));
      return;
    }
    navigateAdjustments(event.nativeEvent, event.currentTarget as unknown as HTMLElement);
  }

  return <div className="raw-point-curve-controls">
    <div className="raw-curve-channels" role="group" aria-label={t('workspace.rawPreview.curveChannels')}
      onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.target as HTMLElement)}>
      {RAW_CURVE_CHANNELS.map(item => <button key={item} type="button" className="raw-curve-channel"
        data-channel={item} aria-label={t(`workspace.rawPreview.curveChannelNames.${item}`)}
        aria-pressed={channel === item} onClick={() => setChannel(item)}>
        {channelLabels[item]}
      </button>)}
    </div>
    <svg className={`raw-curve-graph is-${channel}`} viewBox={`0 0 ${graphSize} ${graphSize}`} role="img" tabIndex={0}
      aria-label={t('workspace.rawPreview.curveGraph')} data-testid="raw-curve-graph" data-channel={channel}
      onFocus={focusAdjustmentCategory} onKeyDown={handleGraphKeyDown} onClick={addOrSelectPoint}>
      <rect className="raw-curve-background" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      {[0.25, 0.5, 0.75].map(fraction => <g key={fraction} className="raw-curve-grid">
        <line x1={graphInset + fraction * graphExtent} y1={graphInset} x2={graphInset + fraction * graphExtent} y2={graphSize - graphInset} />
        <line x1={graphInset} y1={graphInset + fraction * graphExtent} x2={graphSize - graphInset} y2={graphInset + fraction * graphExtent} />
      </g>)}
      <rect className="raw-curve-frame" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      <line className="raw-curve-identity" x1={graphInset} y1={graphSize - graphInset}
        x2={graphSize - graphInset} y2={graphInset} />
      <polyline className="raw-curve-line" data-testid="raw-curve-line" points={line} />
      {visiblePoints.map((point, index) => <circle className={`raw-curve-point${selected[channel] === index ? ' is-selected' : ''}`}
        key={`${point.x}:${point.y}:${index}`} data-testid="raw-curve-point" data-point-index={index}
        aria-selected={selected[channel] === index} cx={graphInset + point.x * graphExtent}
        cy={graphInset + (1 - point.y) * graphExtent} r={selected[channel] === index ? 5 : 3.5}
        onClick={event => { event.stopPropagation(); selectPoint(index, points.length === 0); event.currentTarget.ownerSVGElement?.focus(); }} />)}
    </svg>
  </div>;
}
