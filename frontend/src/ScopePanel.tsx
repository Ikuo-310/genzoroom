import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Histogram } from './histogram';
import { HistogramGraph } from './HistogramGraph';

type Props = { histogram: Histogram | null };

export function ScopePanel({ histogram }: Props) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState({ r: true, g: true, b: true });
  const [yOnly, setYOnly] = useState(false);
  const channelNames = { r: t('workspace.histogramRed'), g: t('workspace.histogramGreen'), b: t('workspace.histogramBlue') };

  return <div className="scope-panel">
    <div className="scope-panel-toolbar">
      <label className="scope-type-label">
        <span>{t('workspace.scopeType')}</span>
        <select aria-label={t('workspace.scopeType')} defaultValue="histogram">
          <option value="histogram">{t('workspace.histogram')}</option>
        </select>
      </label>
      <div className="histogram-channel-controls" role="group" aria-label={t('workspace.histogramChannels')}>
        {(['r', 'g', 'b'] as const).map((channel) => <button key={channel} type="button"
          className={`histogram-channel-button channel-${channel}${channels[channel] ? ' selected' : ''}`}
          aria-label={channelNames[channel]} aria-pressed={channels[channel]} disabled={yOnly}
          onClick={() => setChannels((current) => ({ ...current, [channel]: !current[channel] }))}>
          {channel.toUpperCase()}
        </button>)}
        <button type="button" className={`histogram-y-button${yOnly ? ' selected' : ''}`} aria-pressed={yOnly}
          onClick={() => setYOnly((current) => !current)}>{t('workspace.yOnly')}</button>
      </div>
    </div>
    <HistogramGraph histogram={histogram} channels={channels} yOnly={yOnly} />
  </div>;
}
