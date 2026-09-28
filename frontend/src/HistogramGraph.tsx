import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Histogram } from './histogram';

type Props = { histogram: Histogram | null; channels: { r: boolean; g: boolean; b: boolean }; yOnly: boolean; expanded: boolean };

const BASELINE = 105;
const PLOT_HEIGHT = 91;

export function histogramDisplayMaximum(histogram: Histogram, yOnly: boolean, expanded: boolean): number {
  const bins = yOnly ? [histogram.y] : [histogram.r, histogram.g, histogram.b];
  if (!expanded) return Math.max(1, ...bins.map((channel) => Math.max(...channel)));

  const sorted = bins.flatMap((channel) => Array.from(channel)).sort((a, b) => a - b);
  const nearestRank = Math.ceil(sorted.length * 0.99);
  return Math.max(1, sorted[nearestRank - 1] ?? 0);
}

export function HistogramGraph({ histogram, channels, yOnly, expanded }: Props) {
  const { t } = useTranslation();
  const visible = yOnly ? ['y'] as const : (['r', 'g', 'b'] as const).filter((channel) => channels[channel]);
  // Keep the RGB vertical scale stable while channels are toggled for comparison.
  const maxCount = useMemo(
    () => histogram ? histogramDisplayMaximum(histogram, yOnly, expanded) : 1,
    [histogram, yOnly, expanded],
  );

  return <div className="histogram-graph-wrap">
    <svg className="histogram-graph" viewBox="0 0 256 128" preserveAspectRatio="none" role="img"
      aria-label={t('workspace.histogramGraph')}>
      <path className="histogram-gridline" d="M0 14.5H256 M0 59.5H256" />
      <path className="histogram-baseline" d="M0 105.5H256" />
      {histogram && visible.map((channel) => {
        const bins = histogram[channel];
        const points = Array.from(bins, (count, index) => `${index},${BASELINE - Math.min(count, maxCount) / maxCount * PLOT_HEIGHT}`);
        const color = channel === 'y' ? 'var(--histogram-y)' : `var(--histogram-${channel})`;
        return <path key={channel} className={`histogram-series histogram-series-${channel}`}
          data-channel={channel} d={`M0,${BASELINE} L${points.join(' L')} L255,${BASELINE} Z`}
          fill={color} stroke={color} />;
      })}
    </svg>
    <div className="histogram-y-axis" aria-hidden="true">
      <span>{expanded ? t('workspace.histogramExpandedMaximum', { count: maxCount.toLocaleString() }) : maxCount.toLocaleString()}</span><span>0</span>
    </div>
    <div className="histogram-x-axis" aria-hidden="true"><span>0</span><span>128</span><span>255</span></div>
    {!histogram && <p className="histogram-message">{t('workspace.histogramLoading')}</p>}
    {histogram && visible.length === 0 && <p className="histogram-message">{t('workspace.histogramNoChannels')}</p>}
  </div>;
}
