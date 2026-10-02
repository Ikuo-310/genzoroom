import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SMOKE_CASES, WebGpuSmoke, type DiagnosticValue, type SmokeEnvironment, type SmokeFactory, type SmokeState } from './webgpuSmoke';

export function WebGpuDiagnostics({ environment, factory }: { environment?: SmokeEnvironment; factory?: SmokeFactory }) {
  const { t } = useTranslation();
  const owner = useRef<WebGpuSmoke | null>(null);
  const [state, setState] = useState<SmokeState | null>(null);
  const [context] = useState(() => environment ?? {
    secureContext: window.isSecureContext,
    gpu: (navigator as Navigator & { gpu?: SmokeEnvironment['gpu'] }).gpu,
  });
  useEffect(() => {
    // Each effect owns a fresh runner so StrictMode cleanup cannot close its replacement.
    let smoke = new WebGpuSmoke(context, value => setState({ ...value, results: [...value.results] }), factory);
    owner.current = smoke;
    setState({ ...smoke.state });
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      smoke.dispose();
      smoke = new WebGpuSmoke(context, value => setState({ ...value, results: [...value.results] }), factory);
      owner.current = smoke;
      setState({ ...smoke.state });
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
  }, [context, factory]);
  const describe = (value: DiagnosticValue) => `${t(`webgpuSmoke.codes.${value.code}`)}${value.detail ? `: ${value.detail}` : ''}`;
  return <section aria-labelledby="webgpu-title" className="developer-section">
    <h2 id="webgpu-title">{t('webgpuSmoke.title')}</h2>
    <p>{t('webgpuSmoke.imageDescription')}</p>
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
    <button type="button" disabled={!state || state.running} onClick={() => { void owner.current?.run(); }}>{t('webgpuSmoke.run')}</button>
    <p role="status" aria-live="polite" aria-atomic="true">{state && describe(state.status)}</p>
    <p>{t('webgpuSmoke.comparison')}</p><p>{t('webgpuSmoke.numericNotes')}</p>
    <div className="developer-table-scroll" tabIndex={0} role="region" aria-label={t('webgpuSmoke.results')}>
      <table><thead><tr>{['recipeCase', 'execution', 'maximumDifference', 'differingChannels', 'alphaMatches', 'error'].map(key => <th scope="col" key={key}>{t(`webgpuSmoke.${key}`)}</th>)}</tr></thead>
        <tbody>{SMOKE_CASES.map(({ name }) => {
          const result = state?.results.find(row => row.name === name);
          return <tr key={name}><th scope="row">{name}</th>
            <td>{t(`webgpuSmoke.codes.${result ? result.success ? 'success' : 'failed' : 'idle'}`)}</td>
            <td>{result?.comparison?.maximumDifference ?? '—'}</td><td>{result?.comparison?.differingChannels ?? '—'}</td>
            <td>{result?.comparison ? t(`webgpuSmoke.${result.comparison.alphaMatches ? 'matches' : 'differs'}`) : '—'}</td>
            {/* React escapes raw browser and GPU text; never interpret it as markup. */}
            <td>{result?.errorCode ? t(`webgpuSmoke.codes.${result.errorCode}`) : result?.error ?? '—'}</td></tr>;
        })}</tbody></table>
    </div>
  </section>;
}
