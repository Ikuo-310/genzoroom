import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SMOKE_CASES, WebGpuSmoke, type DiagnosticValue, type SmokeEnvironment, type SmokeFactory, type SmokeState } from './webgpuSmoke';
import { createWebGpuReport, type WebGpuReport } from './developerDiagnostics';

export function WebGpuDiagnostics({ environment, factory, onReport, onExport, exportError }: {
  environment?: SmokeEnvironment; factory?: SmokeFactory; onReport?: (report: WebGpuReport) => void;
  onExport?: () => void; exportError?: boolean;
}) {
  const { t } = useTranslation();
  const owner = useRef<WebGpuSmoke | null>(null);
  const [state, setState] = useState<SmokeState | null>(null);
  const [context] = useState(() => environment ?? {
    secureContext: window.isSecureContext,
    gpu: (navigator as Navigator & { gpu?: SmokeEnvironment['gpu'] }).gpu,
  });
  useEffect(() => {
    const publish = (value: SmokeState) => {
      setState({ ...value, results: [...value.results], timing: { ...value.timing } });
      onReport?.(createWebGpuReport(Boolean(context.gpu), value));
    };
    // Each effect owns a fresh runner so StrictMode cleanup cannot close its replacement.
    let smoke = new WebGpuSmoke(context, publish, factory);
    owner.current = smoke;
    publish(smoke.state);
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      smoke.dispose();
      smoke = new WebGpuSmoke(context, publish, factory);
      owner.current = smoke;
      publish(smoke.state);
    };
    // pagehide also covers departure into the browser's back/forward cache.
    const pagehide = () => owner.current?.dispose();
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', restore);
    return () => {
      smoke.dispose(); owner.current = null;
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', restore);
    };
  }, [context, factory, onReport]);
  const describe = (value: DiagnosticValue) => `${t(`webgpuSmoke.codes.${value.code}`)}${value.detail ? `: ${value.detail}` : ''}`;
  const milliseconds = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)} ms`;
  return <section aria-labelledby="webgpu-title" className="developer-section">
    <h2 id="webgpu-title">{t('webgpuSmoke.title')}</h2>
    <p>{t('webgpuSmoke.imageDescription')}</p>
    <div className="developer-actions">
      <button type="button" disabled={!state || state.running} onClick={() => { void owner.current?.run(); }}>{t('webgpuSmoke.run')}</button>
      <button type="button" onClick={onExport}>{t('developer.exportCurrentJson')}</button>
    </div>
    {exportError && <p role="alert">{t('developer.webgpuExportFailed')}</p>}
    <dl className="developer-diagnostics">
      <div><dt>{t('webgpuSmoke.secure')}</dt><dd>{t(`webgpuSmoke.${context.secureContext ? 'yes' : 'no'}`)}</dd></div>
      <div><dt>{t('webgpuSmoke.api')}</dt><dd>{t(`webgpuSmoke.${context.gpu ? 'yes' : 'no'}`)}</dd></div>
      {state && <>
        {(['adapter', 'device', 'shader'] as const).map(key => <div key={key}><dt>{t(`webgpuSmoke.${key}`)}</dt><dd>{describe(state[key])}</dd></div>)}
        <div><dt>{t('webgpuSmoke.info')}</dt><dd>{state.info.data
          ? <dl>{(['vendor', 'architecture', 'device', 'description'] as const).map(key => <div key={key}><dt>{t(`webgpuSmoke.infoLabels.${key}`)}</dt><dd>{state.info.data?.[key] === '' ? 'Blank' : state.info.data?.[key] ?? t('webgpuSmoke.undisclosedInfo')}</dd></div>)}</dl>
          : describe(state.info)}</dd></div>
      </>}
    </dl>
    {state && <>
      {(['adapterCapabilities', 'deviceCapabilities'] as const).map(key => <details key={key}>
        <summary>{t(`webgpuSmoke.${key}`)}</summary>
        <dl className="developer-diagnostics">
          <div><dt>{t('webgpuSmoke.features')}</dt><dd>{state[key]?.features == null ? t('developer.notAvailable')
            : state[key].features.length ? state[key].features.join(', ') : t('webgpuSmoke.noFeatures')}</dd></div>
          <div><dt>{t('webgpuSmoke.limits')}</dt><dd>{state[key]?.limits
            ? <dl>{Object.entries(state[key].limits).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
            : t('developer.notAvailable')}</dd></div>
        </dl>
      </details>)}
      <dl className="developer-diagnostics">{(['totalMs', 'adapterRequestMs', 'deviceRequestMs', 'initializationMs', 'sourceUploadMs'] as const).map(key =>
        <div key={key}><dt>{t(`webgpuSmoke.timing.${key}`)}</dt><dd>{milliseconds(state.timing[key])}</dd></div>)}</dl>
    </>}
    <p role="status" aria-live="polite" aria-atomic="true">{state && describe(state.status)}</p>
    <p>{t('webgpuSmoke.comparison')}</p><p>{t('webgpuSmoke.numericNotes')}</p>
    <p>{t('webgpuSmoke.timingNotes')}</p>
    <div className="developer-table-scroll" tabIndex={0} role="region" aria-label={t('webgpuSmoke.results')}>
      <table><thead><tr>{['recipeCase', 'execution', 'maximumDifference', 'differingChannels', 'alphaMatches', 'cpuMs', 'gpuMs', 'error'].map(key => <th scope="col" key={key}>{t(`webgpuSmoke.${key}`)}</th>)}</tr></thead>
        <tbody>{SMOKE_CASES.map(({ name }) => {
          const result = state?.results.find(row => row.name === name);
          return <tr key={name}><th scope="row">{name}</th>
            <td>{t(`webgpuSmoke.codes.${result ? result.success ? 'success' : 'failed' : 'idle'}`)}</td>
            <td>{result?.comparison?.maximumDifference ?? '—'}</td><td>{result?.comparison?.differingChannels ?? '—'}</td>
            <td>{result?.comparison ? t(`webgpuSmoke.${result.comparison.alphaMatches ? 'matches' : 'differs'}`) : '—'}</td>
            <td>{milliseconds(result?.cpuMs)}</td><td>{milliseconds(result?.gpuMs)}</td>
            {/* React escapes raw browser and GPU text; never interpret it as markup. */}
            <td>{result?.errorCode ? t(`webgpuSmoke.codes.${result.errorCode}`) : result?.error ?? '—'}</td></tr>;
        })}</tbody></table>
    </div>
  </section>;
}
