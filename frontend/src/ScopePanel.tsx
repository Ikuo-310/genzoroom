import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Histogram } from './histogram';
import { isNativeEditingTarget } from './editShortcuts';
import { HistogramGraph } from './HistogramGraph';

type Props = { histogram: Histogram | null; keyboardBlocked?: boolean };
type Channel = 'r' | 'g' | 'b';
type Channels = Record<Channel, boolean>;

function toggleChannel(current: Channels, channel: Channel): Channels {
  if (current[channel] && Object.values(current).filter(Boolean).length === 1) return current;
  return { ...current, [channel]: !current[channel] };
}

export function ScopePanel({ histogram, keyboardBlocked = false }: Props) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState({ r: true, g: true, b: true });
  const [yOnly, setYOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const channelNames = { r: t('workspace.histogramRed'), g: t('workspace.histogramGreen'), b: t('workspace.histogramBlue') };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const channel = event.code === 'Numpad1' ? 'r' : event.code === 'Numpad2' ? 'g' : event.code === 'Numpad3' ? 'b' : null;
      const isYToggle = event.code === 'Numpad0';
      if ((!channel && !isYToggle) || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey
        || event.metaKey || event.shiftKey || isNativeEditingTarget(event.target) || keyboardBlocked
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      event.preventDefault();
      if (event.repeat) return;
      if (isYToggle) setYOnly((current) => !current);
      else if (channel) {
        if (yOnly) setYOnly(false);
        else setChannels((current) => toggleChannel(current, channel));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keyboardBlocked, yOnly]);

  return <div className="scope-panel">
    <div className="scope-panel-toolbar">
      <label className="scope-type-label">
        <span>{t('workspace.scopeType')}</span>
        <select aria-label={t('workspace.scopeType')} defaultValue="histogram">
          <option value="histogram">{t('workspace.histogram')}</option>
        </select>
      </label>
      <div className="histogram-channel-controls" role="group" aria-label={t('workspace.histogramChannels')}>
        <div className="histogram-scale-controls" role="group" aria-label={t('workspace.histogramScale')}>
          <button type="button" aria-pressed={!expanded} className={!expanded ? 'selected' : ''}
            onClick={() => setExpanded(false)}>{t('workspace.histogramNormal')}</button>
          <button type="button" aria-pressed={expanded} className={expanded ? 'selected' : ''}
            onClick={() => setExpanded(true)}>{t('workspace.histogramExpanded')}</button>
        </div>
        {(['r', 'g', 'b'] as const).map((channel) => <button key={channel} type="button"
          className={`histogram-channel-button channel-${channel}${channels[channel] ? ' selected' : ''}`}
          aria-label={channelNames[channel]} aria-pressed={channels[channel]} disabled={yOnly}
          onClick={() => setChannels((current) => toggleChannel(current, channel))}>
          {channel.toUpperCase()}
        </button>)}
        <button type="button" className={`histogram-y-button${yOnly ? ' selected' : ''}`} aria-pressed={yOnly}
          onClick={() => setYOnly((current) => !current)}>{t('workspace.yOnly')}</button>
      </div>
    </div>
    <HistogramGraph histogram={histogram} channels={channels} yOnly={yOnly} expanded={expanded} />
  </div>;
}
