import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusAdjustmentCategory, navigateAdjustments } from './adjustmentFocus';
import { RAW_CURVE_CHANNELS, type RawCurveChannel, type RawCurvePoint } from './rawApi';

const channelLabels: Record<RawCurveChannel, string> = {
  master: 'RGB', red: 'R', green: 'G', blue: 'B',
};
const graphSize = 256;
const graphInset = 12;
const graphExtent = graphSize - graphInset * 2;

function svgPoint(point: RawCurvePoint) {
  return `${graphInset + point.x * graphExtent},${graphInset + (1 - point.y) * graphExtent}`;
}

export function RawPointCurveControls({ curve }: {
  curve: Record<RawCurveChannel, RawCurvePoint[]>;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<RawCurveChannel>('master');
  const points = curve[channel];
  const line = points.length ? points.map(svgPoint).join(' ') : `${svgPoint({ x: 0, y: 0 })} ${svgPoint({ x: 1, y: 1 })}`;

  return <div className="raw-point-curve-controls">
    <div className="raw-curve-channels" role="group" aria-label={t('workspace.rawPreview.curveChannels')}
      onFocus={focusAdjustmentCategory} onKeyDown={event => navigateAdjustments(event.nativeEvent, event.target as HTMLElement)}>
      {RAW_CURVE_CHANNELS.map(item => <button key={item} type="button" className="raw-curve-channel"
        data-channel={item} aria-label={t(`workspace.rawPreview.curveChannelNames.${item}`)}
        aria-pressed={channel === item} onClick={() => setChannel(item)}>
        {channelLabels[item]}
      </button>)}
    </div>
    <svg className={`raw-curve-graph is-${channel}`} viewBox={`0 0 ${graphSize} ${graphSize}`} role="img"
      aria-label={t('workspace.rawPreview.curveGraph')} data-testid="raw-curve-graph" data-channel={channel}>
      <rect className="raw-curve-background" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      {[0.25, 0.5, 0.75].map(fraction => <g key={fraction} className="raw-curve-grid">
        <line x1={graphInset + fraction * graphExtent} y1={graphInset} x2={graphInset + fraction * graphExtent} y2={graphSize - graphInset} />
        <line x1={graphInset} y1={graphInset + fraction * graphExtent} x2={graphSize - graphInset} y2={graphInset + fraction * graphExtent} />
      </g>)}
      <rect className="raw-curve-frame" x={graphInset} y={graphInset} width={graphExtent} height={graphExtent} />
      <line className="raw-curve-identity" x1={graphInset} y1={graphSize - graphInset}
        x2={graphSize - graphInset} y2={graphInset} />
      <polyline className="raw-curve-line" data-testid="raw-curve-line" points={line} />
      {points.map((point, index) => <circle className="raw-curve-point" key={`${point.x}:${point.y}:${index}`}
        data-testid="raw-curve-point" cx={graphInset + point.x * graphExtent}
        cy={graphInset + (1 - point.y) * graphExtent} r="3.5" />)}
    </svg>
  </div>;
}
