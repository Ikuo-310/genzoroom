import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchRecentAssets } from './api';
import type { RecentAsset } from './assets';
import { JPEG_CASES, RealJpegRunner, recentJpegCandidates, type JpegDiagnosticsDependencies, type JpegRunState } from './jpegDiagnostics';
import { emptyJpegReport, type JpegReport } from './jpegDiagnosticsReport';

export function RealJpegDiagnostics({ onReport, dependencies, onExport, exportError }: {
  onReport?: (report: JpegReport) => void; dependencies?: Partial<JpegDiagnosticsDependencies>;
  onExport?: () => void; exportError?: boolean;
}) {
  const { t } = useTranslation();
  const runner = useRef<RealJpegRunner | null>(null);
  const candidateRequest = useRef<AbortController | null>(null);
  const [state, setState] = useState<JpegRunState>({ running: false, phase: 'idle', currentCase: null, report: emptyJpegReport() });
  const [candidates, setCandidates] = useState<RecentAsset[]>([]);
  const [candidateStatus, setCandidateStatus] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'empty'>('idle');
  const [manual, setManual] = useState<RecentAsset | null>(null);
  const [targetFilename, setTargetFilename] = useState<string | null>(null);
  const busy = state.running || candidateStatus === 'loading';
  useEffect(() => {
    const update = (value: JpegRunState) => { setState(value); onReport?.(value.report); };
    const create = () => new RealJpegRunner(update, dependencies, asset => setTargetFilename(asset.filename));
    let owner = create(); runner.current = owner;
    update(owner.state);
    const hide = () => {
      owner.dispose(); candidateRequest.current?.abort(); candidateRequest.current = null;
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      owner.dispose(); owner = create(); runner.current = owner;
      setCandidateStatus('idle'); setCandidates([]); setManual(null); setTargetFilename(null);
      update(owner.state);
    };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => {
      hide(); runner.current = null;
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    };
  }, [dependencies, onReport]);
  const loadCandidates = async () => {
    if (busy || candidateRequest.current || runner.current?.state.running) return;
    const controller = new AbortController(); candidateRequest.current = controller;
    setCandidateStatus('loading'); setCandidates([]);
    try {
      const selected = recentJpegCandidates(await (dependencies?.recent ?? fetchRecentAssets)(50, controller.signal));
      if (controller.signal.aborted) return;
      setCandidates(selected); setCandidateStatus(selected.length ? 'ready' : 'empty');
    } catch { if (!controller.signal.aborted) setCandidateStatus('failed'); }
    finally { if (candidateRequest.current === controller) candidateRequest.current = null; }
  };
  const milliseconds = (value: number | null) => value === null ? '—' : `${value.toFixed(2)} ms`;
  const report = state.report;
  const filename = manual?.filename ?? targetFilename;
  return <section className="developer-section" aria-labelledby="jpeg-diagnostics-title">
    <h2 id="jpeg-diagnostics-title">{t('jpegDiagnostics.title')}</h2>
    <p>{t('jpegDiagnostics.description')}</p>
    <p className="developer-jpeg-target">{t(`jpegDiagnostics.selection.${manual ? 'manual' : 'automatic'}`)}{filename ? `: ${filename}` : ''}</p>
    <div className="developer-actions">
      <button type="button" disabled={busy} onClick={() => { void loadCandidates(); }}>{t('jpegDiagnostics.choose')}</button>
      {manual && <button type="button" disabled={busy} onClick={() => { setManual(null); setTargetFilename(null); }}>{t('jpegDiagnostics.automatic')}</button>}
      <button type="button" disabled={busy} onClick={() => {
        if (candidateRequest.current || runner.current?.state.running) return;
        if (!manual) setTargetFilename(null);
        void runner.current?.run(manual);
      }}>{t('jpegDiagnostics.run')}</button>
      <button type="button" onClick={onExport}>{t('developer.exportCurrentJson')}</button>
    </div>
    {exportError && <p role="alert">{t('developer.jpegExportFailed')}</p>}
    {candidateStatus !== 'idle' && <p role="status">{t(`jpegDiagnostics.candidates.${candidateStatus}`)}</p>}
    {candidates.length > 0 && <div className="developer-jpeg-candidates" role="group" aria-label={t('jpegDiagnostics.candidateLabel')}>
      {candidates.map((asset, index) => <button type="button" key={asset.id} disabled={busy} aria-pressed={manual?.id === asset.id}
        onClick={() => { setManual(asset); setTargetFilename(asset.filename); }}>
        <img src={asset.thumbnail_url} alt={t('jpegDiagnostics.candidateAlt', { number: index + 1 })} loading="lazy" />
        <span>{asset.filename}</span>
      </button>)}
    </div>}
    <p role="status" aria-live="polite" aria-atomic="true">{t(`jpegDiagnostics.status.${report.status}`)}
      {state.running && ` — ${t(`jpegDiagnostics.phase.${state.phase}`)}${state.currentCase ? `: ${t(`jpegDiagnostics.case.${state.currentCase}`)}` : ''}`}
    </p>
    {report.error && <p role="alert">{t(`jpegDiagnostics.error.${report.error.code}`)}</p>}
    <dl className="developer-diagnostics">
      <div><dt>{t('jpegDiagnostics.compressedBytes')}</dt><dd>{report.source.compressedBytes ?? '—'}</dd></div>
      <div><dt>{t('jpegDiagnostics.dimensions')}</dt><dd>{report.source.width !== null ? `${report.source.width} × ${report.source.height}` : '—'}</dd></div>
      <div><dt>{t('jpegDiagnostics.profile')}</dt><dd>{t(`jpegDiagnostics.profileStatus.${report.source.profile.status}`)}
        {report.source.profile.description && `: ${report.source.profile.description}`}</dd></div>
      {Object.entries(report.timing).map(([key, value]) => <div key={key}><dt>{t(`jpegDiagnostics.timing.${key}`)}</dt><dd>{milliseconds(value)}</dd></div>)}
      <div><dt>{t('jpegDiagnostics.gpuStatus')}</dt><dd>{t(`jpegDiagnostics.gpu.${report.gpu.status}`)}
        {report.gpu.error && `: ${t(`jpegDiagnostics.error.${report.gpu.error.code}`)}`}</dd></div>
    </dl>
    <p>{t('jpegDiagnostics.timingNotes')}</p>
    <div className="developer-table-scroll" tabIndex={0} role="region" aria-label={t('jpegDiagnostics.results')}>
      <table><thead><tr>{['case', 'cpuRenderMs', 'cpuHistogramMs', 'gpuRenderMs', 'gpuHistogramMs', 'status'].map(key =>
        <th scope="col" key={key}>{t(`jpegDiagnostics.columns.${key}`)}</th>)}</tr></thead>
        <tbody>{JPEG_CASES.map(({ id }) => {
          const row = report.cases.find(value => value.id === id);
          return <tr key={id}><th scope="row">{t(`jpegDiagnostics.case.${id}`)}</th>
            {(['cpuRenderMs', 'cpuHistogramMs', 'gpuRenderMs', 'gpuHistogramMs'] as const).map(key => <td key={key}>{milliseconds(row?.[key] ?? null)}</td>)}
            <td>{t(`jpegDiagnostics.status.${row?.status ?? 'not_run'}`)}
              {row?.cpuError && `: ${t(`jpegDiagnostics.error.${row.cpuError.code}`)}`}
              {row?.gpuError && `: ${t(`jpegDiagnostics.error.${row.gpuError.code}`)}`}</td></tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}
