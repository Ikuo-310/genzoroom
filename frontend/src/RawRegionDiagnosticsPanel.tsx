import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createRawRegionDiagnosticsChannel, type RawRegionDiagnosticMessage, type RawRegionDiagnosticState,
  type RawRegionPosition } from './rawRegionDiagnostics';
import { rawRegionDiagnosticError } from './rawRegionDiagnostics';

const initial: RawRegionDiagnosticState = { connected: false, supported: null, wholeQuality: null, wholeGeometry: null,
  regionGeometry: null, geometryMatches: null, regionSize: null, displayed: false, beforeReady: false,
  comparing: false, position: null, requesting: false, cleared: true, details: null };
const positions: RawRegionPosition[] = ['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'left', 'right', 'top', 'bottom'];

export function RawRegionDiagnostics({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState(initial);
  const [compare, setCompare] = useState(false);
  const [outline, setOutline] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const channel = useRef<ReturnType<typeof createRawRegionDiagnosticsChannel>>(null);
  const clientId = useRef('');
  const ownerId = useRef<string | undefined>(undefined);
  const send = (message: RawRegionDiagnosticMessage) => { try { channel.current?.postMessage(message); } catch { /* Diagnostics are best effort. */ } };
  useEffect(() => {
    if (!active) return;
    const bus = createRawRegionDiagnosticsChannel();
    channel.current = bus;
    clientId.current = crypto.randomUUID();
    if (!bus) { setState(initial); setError('channelUnavailable'); return; }
    bus.onmessage = event => {
      const message = event.data as RawRegionDiagnosticMessage;
      if (!message || message.clientId !== clientId.current) return;
      if (message.type === 'state') { ownerId.current = message.ownerId; setState(message.state); if (message.state.errorCode) setError(message.state.errorCode); }
      if (message.type === 'result') {
        setPending(false);
        setError(message.ok ? undefined : message.errorCode ?? 'raw_region_unavailable');
        send({ type: 'state.request', clientId: clientId.current });
      }
    };
    send({ type: 'attach', clientId: clientId.current });
    send({ type: 'state.request', clientId: clientId.current });
    const timeout = window.setTimeout(() => setState(current => current.connected ? current : initial), 500);
    return () => {
      window.clearTimeout(timeout);
      send({ type: 'detach', clientId: clientId.current });
      bus.close(); channel.current = null; setPending(false); setOutline(false);
    };
  }, [active]);
  const action = (kind: 'clear' | 'outline' | 'request', options?: { position?: RawRegionPosition; compare?: boolean }) => {
    if (!channel.current) return;
    setError(undefined);
    const actionId = crypto.randomUUID();
    if (kind === 'request') setPending(true);
    else setPending(false);
    const message: RawRegionDiagnosticMessage = kind === 'clear'
      ? { type: 'action', clientId: clientId.current, ownerId: ownerId.current, actionId, action: 'clear' }
      : kind === 'outline'
        ? { type: 'action', clientId: clientId.current, ownerId: ownerId.current, actionId, action: 'outline', enabled: !outline }
        : { type: 'action', clientId: clientId.current, ownerId: ownerId.current, actionId, action: 'request', position: options!.position!, compare: !!options!.compare };
    if (kind === 'outline') setOutline(value => !value);
    send(message);
  };
  const status = !state.connected ? 'notConnected' : state.supported === false ? 'unsupported' : (error || state.errorCode) ? 'error'
    : state.requesting || pending ? 'requesting' : state.displayed ? 'displaying'
      : state.wholeQuality !== 'full' ? 'wholeWaiting' : 'ready';
  const reportedError = error ?? state.errorCode;
  const errorKey = reportedError ? reportedError === 'channelUnavailable' ? reportedError : rawRegionDiagnosticError(reportedError) : undefined;
  const canRequest = state.connected && state.supported === true && state.wholeQuality === 'full' && !pending
    && (!compare || state.beforeReady);
  return <section className="developer-section raw-region-diagnostics" aria-labelledby="raw-region-diagnostics-title">
    <h2 id="raw-region-diagnostics-title">{t('rawRegionDiagnostics.title')}</h2>
    <p>{t('rawRegionDiagnostics.note')}</p>
    <dl className="developer-diagnostics">
      <div><dt>{t('rawRegionDiagnostics.statusLabel')}</dt><dd role="status">{t(`rawRegionDiagnostics.status.${status}`)}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.position')}</dt><dd>{state.position ? t(`rawRegionDiagnostics.positions.${state.position}`) : t('rawRegionDiagnostics.none')}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.quality')}</dt><dd>{state.wholeQuality ? t(`rawRegionDiagnostics.qualities.${state.wholeQuality}`) : t('rawRegionDiagnostics.none')}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.beforeCompare')}</dt><dd>{compare ? t('rawRegionDiagnostics.on') : t('rawRegionDiagnostics.off')}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.geometry')}</dt><dd>{state.geometryMatches === null ? t('rawRegionDiagnostics.notChecked')
        : t(state.geometryMatches ? 'rawRegionDiagnostics.match' : 'rawRegionDiagnostics.mismatch')}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.regionSize')}</dt><dd>{state.regionSize ? `${state.regionSize.width} × ${state.regionSize.height}` : t('rawRegionDiagnostics.none')}</dd></div>
      <div><dt>{t('rawRegionDiagnostics.clearedLabel')}</dt><dd>{state.cleared ? t('rawRegionDiagnostics.yes') : t('rawRegionDiagnostics.no')}</dd></div>
    </dl>
    <div className="raw-region-position-buttons">{positions.map(position => <button key={position} type="button"
      disabled={!canRequest} onClick={() => action('request', { position, compare })}>{t(`rawRegionDiagnostics.positions.${position}`)}</button>)}</div>
    <div className="developer-actions raw-region-options">
      <label><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} /> {t('rawRegionDiagnostics.compare')}</label>
      <button type="button" disabled={!state.connected} onClick={() => action('clear')}>{t('rawRegionDiagnostics.clear')}</button>
      <label><input type="checkbox" checked={outline} disabled={!state.connected} onChange={() => action('outline')} /> {t('rawRegionDiagnostics.outline')}</label>
    </div>
    {!state.connected && active && <p>{t('rawRegionDiagnostics.errors.notConnected')}</p>}
    {state.supported === false && <p>{t('rawRegionDiagnostics.errors.capability')}</p>}
    {state.connected && state.supported && state.wholeQuality !== 'full' && <p>{t('rawRegionDiagnostics.errors.wholeWaiting')}</p>}
    {compare && state.connected && state.supported && !state.beforeReady && <p>{t('rawRegionDiagnostics.errors.beforeWaiting')}</p>}
    {errorKey && <p role="alert">{t(`rawRegionDiagnostics.errors.${errorKey}`)}{reportedError && errorKey === 'requestFailed' && ` (${reportedError})`}</p>}
    <details><summary>{t('rawRegionDiagnostics.details')}</summary>
      <dl className="developer-diagnostics raw-region-details">
        <div><dt>F</dt><dd>{state.details ? `${state.details.f.fullWidth} × ${state.details.f.fullHeight}` : '—'}</dd></div>
        <div><dt>W</dt><dd>{state.details ? JSON.stringify(state.details.w) : '—'}</dd></div>
        <div><dt>validRegion</dt><dd>{state.details ? JSON.stringify(state.details.validRegion) : '—'}</dd></div>
        <div><dt>revision</dt><dd>{state.details?.revision ?? '—'}</dd></div>
        <div><dt>viewGeneration</dt><dd>{state.details?.viewGeneration ?? '—'}</dd></div>
        <div><dt>planGeneration</dt><dd>{state.details?.planGeneration ?? '—'}</dd></div>
        <div><dt>requestId</dt><dd>{state.details?.requestId ?? '—'}</dd></div>
      </dl>
    </details>
  </section>;
}
