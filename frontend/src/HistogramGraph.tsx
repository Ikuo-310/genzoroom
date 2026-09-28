import { useTranslation } from 'react-i18next';
import type { Histogram } from './histogram';

type Props = { histogram: Histogram | null; channels: { r: boolean; g: boolean; b: boolean }; yOnly: boolean };

const BASELINE = 105;
const PLOT_HEIGHT = 91;

export function HistogramGraph({ histogram, channels, yOnly }: Props) {
  const { t } = useTranslation();
  const visible = yOnly ? ['y'] as const : (['r', 'g', 'b'] as const).filter((channel) => channels[channel]);
  const scaleChannels = yOnly ? ['y'] as const : ['r', 'g', 'b'] as const;
  // Keep the RGB vertical scale stable while channels are toggled for comparison.
  const maxCount = histogram
    ? Math.max(1, ...scaleChannels.map((channel) => Math.max(...histogram[channel]))) : 1;

  return <div className="histogram-graph-wrap">
    <svg className="histogram-graph" viewBox="0 0 256 128" preserveAspectRatio="none" role="img"
      aria-label={t('workspace.histogramGraph')}>
      <path className="histogram-gridline" d="M0 14.5H256 M0 59.5H256" />
      <path className="histogram-baseline" d="M0 105.5H256" />
      <text className="histogram-axis-label" x="2" y="11">{maxCount.toLocaleString()}</text>
      <text className="histogram-axis-label" x="2" y="103">0</text>
      {histogram && visible.map((channel) => {
        const bins = histogram[channel];
        const points = Array.from(bins, (count, index) => `${index},${BASELINE - count / maxCount * PLOT_HEIGHT}`);
        const color = channel === 'y' ? 'var(--histogram-y)' : `var(--histogram-${channel})`;
        return <path key={channel} className={`histogram-series histogram-series-${channel}`}
          data-channel={channel} d={`M0,${BASELINE} L${points.join(' L')} L255,${BASELINE} Z`}
          fill={color} stroke={color} />;
      })}
      <text className="histogram-axis-label" x="1" y="122">0</text>
      <text className="histogram-axis-label" x="128" y="122" textAnchor="middle">128</text>
      <text className="histogram-axis-label" x="255" y="122" textAnchor="end">255</text>
    </svg>
    {!histogram && <p className="histogram-message">{t('workspace.histogramLoading')}</p>}
    {histogram && visible.length === 0 && <p className="histogram-message">{t('workspace.histogramNoChannels')}</p>}
  </div>;
}
