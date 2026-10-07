import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchRecentAssets } from './api';
import type { RecentAsset } from './assets';
import { recentJpegCandidates } from './jpegDiagnostics';
import { getAssetEditState, EditStateApiError } from './editStateApi';
import { decodeEditSource } from './editImageSource';
import { renderAdjustments } from './adjustmentPipeline';
import { ExportEngineDiagnosticError, fetchExportEngineJpeg, type ExportEngineErrorCode, type ExportEngineMetadata } from './exportEngineApi';
import { emptyDecodeComparison, runDecodeComparison, type DecodeComparisonDependencies, type DecodePhase } from './decodeComparison';
import { createExportEngineReport, exportEngineReport, DECODE_STATISTIC_KEYS } from './exportEngineReport';
import { emptyEncodeRoundTrip, runEncodeRoundTrip, type EncodeRoundTripDependencies, type EncodeRoundTripPhase } from './encodeRoundTrip';
import type { EncodeRoundTripErrorCode } from './exportEngineApi';

type Phase = 'idle' | 'recipe' | 'original' | 'preview' | 'backend' | 'completed' | 'failed' | 'cancelled';
export interface ExportEngineDependencies {
  recent: typeof fetchRecentAssets; saved: typeof getAssetEditState; decode: typeof decodeEditSource;
  render: typeof renderAdjustments; backend: typeof fetchExportEngineJpeg;
}

export function ExportEngineDiagnostics({ dependencies, decodeDependencies, roundTripDependencies }: {
  dependencies?: Partial<ExportEngineDependencies>; decodeDependencies?: Partial<DecodeComparisonDependencies>;
  roundTripDependencies?: Partial<EncodeRoundTripDependencies>;
}) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<RecentAsset[]>([]);
  const [selected, setSelected] = useState<RecentAsset | null>(null);
  const [candidateStatus, setCandidateStatus] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'empty'>('idle');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ExportEngineErrorCode | null>(null);
  const [metadata, setMetadata] = useState<ExportEngineMetadata | null>(null);
  const [backendUrl, setBackendUrl] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [decodeReport, setDecodeReport] = useState(emptyDecodeComparison);
  const [decodePhase, setDecodePhase] = useState<DecodePhase>('idle');
  const [roundTripReport, setRoundTripReport] = useState(emptyEncodeRoundTrip);
  const [roundTripPhase, setRoundTripPhase] = useState<EncodeRoundTripPhase>('idle');
  const [jsonError, setJsonError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ownCanvas = useCallback((node: HTMLCanvasElement | null) => {
    // React detaches refs before passive unmount cleanup, so release the backing store here.
    if (canvas.current && canvas.current !== node) { canvas.current.width = 0; canvas.current.height = 0; }
    canvas.current = node;
  }, []);
  const request = useRef<AbortController | null>(null);
  const candidateRequest = useRef<AbortController | null>(null);
  const urls = useRef({ original: null as string | null, backend: null as string | null });
  const closed = useRef(false);
  const busy = ['recipe', 'original', 'preview', 'backend'].includes(phase) || candidateStatus === 'loading'
    || decodeReport.status === 'running' || roundTripReport.status === 'running';
  const release = () => {
    for (const key of ['original', 'backend'] as const) {
      if (urls.current[key]) URL.revokeObjectURL(urls.current[key]!);
      urls.current[key] = null;
    }
    if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
  };
  const reset = () => { release(); setBackendUrl(null); setPreviewReady(false); setMetadata(null); setError(null); };
  useEffect(() => {
    closed.current = false;
    const closeResources = () => {
      closed.current = true;
      request.current?.abort(); request.current = null;
      candidateRequest.current?.abort(); candidateRequest.current = null;
      release();
    };
    const hide = () => {
      closeResources();
      setBackendUrl(null); setPreviewReady(false); setMetadata(null); setError(null); setPhase('cancelled');
      setCandidateStatus('idle');
      setDecodeReport(value => value.status === 'running' ? { ...emptyDecodeComparison(), status: 'cancelled', error: 'cancelled' } : value);
      setDecodePhase('idle');
      setRoundTripReport(value => value.status === 'running' ? { ...emptyEncodeRoundTrip(), status: 'cancelled', error: 'cancelled' } : value);
      setRoundTripPhase('idle');
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      closed.current = false;
      setCandidates([]); setSelected(null); setPhase('idle');
      setDecodeReport(emptyDecodeComparison()); setRoundTripReport(emptyEncodeRoundTrip()); setJsonError(false);
    };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { closeResources(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, []);

  const loadCandidates = async () => {
    if (closed.current || request.current || candidateRequest.current) return;
    const controller = new AbortController(); candidateRequest.current = controller;
    setCandidateStatus('loading'); setCandidates([]); setSelected(null); reset(); setPhase('idle');
    setDecodeReport(emptyDecodeComparison()); setJsonError(false);
    try {
      const assets = recentJpegCandidates(await (dependencies?.recent ?? fetchRecentAssets)(50, controller.signal));
      if (controller.signal.aborted || closed.current || candidateRequest.current !== controller) return;
      setCandidates(assets); setCandidateStatus(assets.length ? 'ready' : 'empty');
    } catch { if (!controller.signal.aborted && !closed.current) setCandidateStatus('failed'); }
    finally { if (candidateRequest.current === controller) candidateRequest.current = null; }
  };

  const runDecode = async () => {
    if (closed.current || request.current || candidateRequest.current || !selected) return;
    const controller = new AbortController(); request.current = controller;
    setDecodeReport({ ...emptyDecodeComparison(), status: 'running' }); setJsonError(false);
    try {
      const report = await runDecodeComparison(selected.id, controller.signal, value => {
        if (!closed.current && request.current === controller) setDecodePhase(value);
      }, { decode: dependencies?.decode ?? decodeEditSource, ...decodeDependencies });
      if (!closed.current && request.current === controller) setDecodeReport(report);
    } finally {
      if (request.current === controller) { request.current = null; setDecodePhase('idle'); }
    }
  };
  const runRoundTrip = async () => {
    if (closed.current || request.current || candidateRequest.current || !selected) return;
    const controller = new AbortController(); request.current = controller;
    setRoundTripReport({ ...emptyEncodeRoundTrip(), status: 'running' }); setJsonError(false);
    try {
      let saved: Awaited<ReturnType<typeof getAssetEditState>> | null = await (dependencies?.saved ?? getAssetEditState)(selected.id, controller.signal, { requireRecipeVersion: 18 });
      if (controller.signal.aborted || closed.current || request.current !== controller) return;
      if (!saved.state || !saved.revision) throw new EncodeRoundTripSafeError('saved_recipe_unavailable');
      if (saved.state.currentRecipe.version !== 18) throw new EncodeRoundTripSafeError('unsupported_recipe_version');
      const revision = saved.revision;
      saved = null;
      const report = await runEncodeRoundTrip(selected.id, revision, controller.signal, value => {
        if (!closed.current && request.current === controller) setRoundTripPhase(value);
      }, { decode: dependencies?.decode ?? decodeEditSource, ...roundTripDependencies });
      if (!closed.current && request.current === controller) setRoundTripReport(report);
    } catch (failure) {
      if (closed.current || request.current !== controller) return;
      const code: EncodeRoundTripErrorCode = controller.signal.aborted ? 'cancelled'
        : failure instanceof EncodeRoundTripSafeError ? failure.code
        : failure instanceof EditStateApiError && failure.code === 'unsupported_recipe_version' ? 'unsupported_recipe_version' : 'saved_recipe_unavailable';
      setRoundTripReport({ ...emptyEncodeRoundTrip(), status: controller.signal.aborted ? 'cancelled' : 'failed', error: code });
    } finally {
      if (request.current === controller) { request.current = null; setRoundTripPhase('idle'); }
    }
  };
  const run = async () => {
    if (closed.current || request.current || candidateRequest.current || !selected) return;
    const controller = new AbortController(); request.current = controller;
    const signal = controller.signal;
    reset();
    let failureCode: ExportEngineErrorCode = 'saved_recipe_unavailable';
    const check = () => { signal.throwIfAborted(); if (closed.current || request.current !== controller) throw new DOMException('Aborted', 'AbortError'); };
    const stage = (value: Phase, code: ExportEngineErrorCode) => { check(); failureCode = code; setPhase(value); };
    try {
      stage('recipe', 'saved_recipe_unavailable');
      let saved: Awaited<ReturnType<typeof getAssetEditState>> | null = await (dependencies?.saved ?? getAssetEditState)(selected.id, signal, { requireRecipeVersion: 18 });
      check();
      if (!saved.state || !saved.revision) throw new ExportEngineDiagnosticError('saved_recipe_unavailable');
      if (saved.state.currentRecipe.version !== 18) throw new ExportEngineDiagnosticError('unsupported_recipe_version');
      // Detach only currentRecipe: never retain History or mutable editor state for this run.
      const recipe = structuredClone(saved.state.currentRecipe);
      const revision = saved.revision;
      saved = null;
      stage('original', 'original_fetch_failed');
      const response = await fetch(`/api/assets/${encodeURIComponent(selected.id)}/original`, { signal, cache: 'no-store' });
      check(); if (!response.ok) throw new ExportEngineDiagnosticError('original_fetch_failed');
      let blob: Blob | null = await response.blob(); check();
      const originalUrl = URL.createObjectURL(blob); urls.current.original = originalUrl; blob = null;
      stage('preview', 'decode_failed');
      let source: ImageData | null;
      try { source = await (dependencies?.decode ?? decodeEditSource)({ kind: 'jpeg-original', url: originalUrl }, signal); check(); }
      finally {
        // A late old decoder must not release a newer run's URL after BFCache restoration.
        if (urls.current.original === originalUrl) { URL.revokeObjectURL(originalUrl); urls.current.original = null; }
      }
      failureCode = 'render_failed';
      // Yield before synchronous full-resolution math so pending departure events can abort.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0)); check();
      const draw = () => {
        const output = (dependencies?.render ?? renderAdjustments)(source!.data, recipe);
        const target = canvas.current; if (!target) throw new Error();
        target.width = source!.width; target.height = source!.height;
        const context = target.getContext('2d', { colorSpace: 'srgb' }); if (!context) throw new Error();
        context.putImageData(new ImageData(output, source!.width, source!.height, { colorSpace: 'srgb' }), 0, 0);
      };
      draw(); source = null; setPreviewReady(true);
      stage('backend', 'backend_unavailable');
      const result = await (dependencies?.backend ?? fetchExportEngineJpeg)(selected.id, revision, signal); check();
      urls.current.backend = URL.createObjectURL(result.blob);
      setBackendUrl(urls.current.backend); setMetadata(result.metadata); setPhase('completed');
    } catch (failure) {
      if (closed.current || request.current !== controller) return;
      reset();
      if (signal.aborted) setPhase('cancelled');
      else {
        const code = failure instanceof ExportEngineDiagnosticError ? failure.code
          : failure instanceof EditStateApiError && failure.code === 'unsupported_recipe_version' ? 'unsupported_recipe_version' : failureCode;
        setError(code); setPhase('failed');
      }
    } finally { if (request.current === controller) request.current = null; }
  };

  return <section className="developer-section" aria-labelledby="export-engine-title">
    <h2 id="export-engine-title">Export Engine</h2><p>{t('exportEngine.description')}</p>
    <p>{t('exportEngine.settings')}</p>
    <div className="developer-actions">
      <button type="button" disabled={busy} onClick={() => { void loadCandidates(); }}>{t('jpegDiagnostics.choose')}</button>
      <button type="button" disabled={busy || !selected} onClick={() => { void run(); }}>{t('exportEngine.run')}</button>
      <button type="button" disabled={busy} onClick={() => {
        setJsonError(false);
        try { exportEngineReport(createExportEngineReport({ status: phase, error, metadata }, decodeReport, new Date(), roundTripReport)); }
        catch { setJsonError(true); }
      }}>{t('decodeCompare.exportJson')}</button>
    </div>
    {candidateStatus !== 'idle' && <p role="status">{t(`jpegDiagnostics.candidates.${candidateStatus}`)}</p>}
    {candidateStatus === 'failed' && <p role="alert">{t('exportEngine.error.candidate_load_failed')}</p>}
    {candidates.length > 0 && <div className="developer-jpeg-candidates" role="group" aria-label={t('jpegDiagnostics.candidateLabel')}>
      {candidates.map((asset, index) => <button type="button" key={asset.id} disabled={busy} aria-pressed={selected?.id === asset.id} onClick={() => {
        if (request.current || candidateRequest.current || closed.current) return;
        reset(); setPhase('idle'); setSelected(asset); setDecodeReport(emptyDecodeComparison()); setRoundTripReport(emptyEncodeRoundTrip()); setJsonError(false);
      }}><img src={asset.thumbnail_url} alt={t('jpegDiagnostics.candidateAlt', { number: index + 1 })} loading="lazy" /><span>{asset.filename}</span></button>)}
    </div>}
    {selected && <p className="developer-jpeg-target">{selected.filename}</p>}
    {jsonError && <p role="alert">{t('decodeCompare.jsonFailed')}</p>}
    <p role="status" aria-live="polite">{t(`exportEngine.status.${phase}`)}</p>
    {error && <p role="alert">{t(`exportEngine.error.${error}`)}</p>}
    <div className="developer-export-comparison">
      <figure><figcaption>{t('exportEngine.frontend')}</figcaption><canvas className="developer-export-image" ref={ownCanvas} hidden={!previewReady} aria-label={t('exportEngine.frontend')} /></figure>
      <figure><figcaption>{t('exportEngine.backend')}</figcaption>{backendUrl && <img className="developer-export-image" src={backendUrl} alt={t('exportEngine.backend')} />}</figure>
    </div>
    {metadata && <dl className="developer-diagnostics">{Object.entries(metadata).map(([key, value]) =>
      <div key={key}><dt>{t(`exportEngine.values.${key}`)}</dt><dd>{key === 'sourceIcc' ? t(`jpegDiagnostics.profileStatus.${value === 'embedded' ? 'embedded' : 'none'}`)
        : key.endsWith('Ms') ? `${Number(value).toFixed(2)} ms` : value}</dd></div>)}</dl>}
    <section aria-labelledby="decode-compare-title">
      <h3 id="decode-compare-title">{t('decodeCompare.title')}</h3><p>{t('decodeCompare.description')}</p>
      <p>{t('decodeCompare.notes')}</p>
      <div className="developer-actions">
        <button type="button" disabled={busy || !selected} onClick={() => { void runDecode(); }}>{t('decodeCompare.run')}</button>
        <button type="button" disabled={decodeReport.status !== 'running'} onClick={() => request.current?.abort()}>{t('decodeCompare.cancel')}</button>
      </div>
      <p role="status" aria-live="polite">{t(`decodeCompare.status.${decodeReport.status}`)}
        {decodeReport.status === 'running' && ` — ${t(`decodeCompare.phase.${decodePhase}`)}`}</p>
      {decodeReport.error && <p role="alert">{t(`decodeCompare.error.${decodeReport.error}`)}</p>}
      {decodeReport.assessment && <p>{t(`decodeCompare.assessment.${decodeReport.assessment.brightnessDirection}`)} · {t(`decodeCompare.assessment.${decodeReport.assessment.tintDirection}`)} · {t(`decodeCompare.assessment.${decodeReport.assessment.differenceLevel}`)}</p>}
      <dl className="developer-diagnostics">
        {(['frontend', 'backend'] as const).map(side => <div key={side}><dt>{t(`decodeCompare.${side}Dimensions`)}</dt>
          <dd>{decodeReport.dimensions[side] ? `${decodeReport.dimensions[side]!.width} × ${decodeReport.dimensions[side]!.height}` : '—'}</dd></div>)}
        <div><dt>{t('decodeCompare.sourceIcc')}</dt><dd>{decodeReport.sourceIcc ? t(`jpegDiagnostics.profileStatus.${decodeReport.sourceIcc === 'embedded' ? 'embedded' : 'none'}`) : '—'}</dd></div>
        <div><dt>{t('decodeCompare.orientation')}</dt><dd>{decodeReport.orientationNormalized === null ? '—' : t(`webgpuSmoke.${decodeReport.orientationNormalized ? 'yes' : 'no'}`)}</dd></div>
        {Object.entries(decodeReport.timing).map(([key, value]) => <div key={key}><dt>{t(`decodeCompare.timing.${key}`)}</dt><dd>{value === null ? '—' : `${value.toFixed(2)} ms`}</dd></div>)}
      </dl>
      {decodeReport.statistics && <><h4>{t('decodeCompare.statistics')}</h4><dl className="developer-diagnostics">
        {DECODE_STATISTIC_KEYS.map(key => <div key={key}><dt>{t(`decodeCompare.values.${key}`)}</dt><dd>{decodeReport.statistics![key].toFixed(6)}{key.endsWith('Percent') ? ' %' : ''}</dd></div>)}
      </dl></>}
    </section>
    <section aria-labelledby="encode-roundtrip-title">
      <h3 id="encode-roundtrip-title">{t('encodeRoundTrip.title')}</h3><p>{t('encodeRoundTrip.description')}</p>
      <p>{t('encodeRoundTrip.deltaNote')}</p>
      <div className="developer-actions">
        <button type="button" disabled={busy || !selected} onClick={() => { void runRoundTrip(); }}>{t('encodeRoundTrip.run')}</button>
        <button type="button" disabled={roundTripReport.status !== 'running'} onClick={() => request.current?.abort()}>{t('encodeRoundTrip.cancel')}</button>
      </div>
      <p role="status" aria-live="polite">{t(`encodeRoundTrip.status.${roundTripReport.status}`)}
        {roundTripReport.status === 'running' && ` — ${t(`encodeRoundTrip.phase.${roundTripPhase}`)}`}</p>
      {roundTripReport.error && <p role="alert">{t(`encodeRoundTrip.error.${roundTripReport.error}`)}</p>}
      {roundTripReport.assessment && <p>{t(`encodeRoundTrip.assessment.${roundTripReport.assessment.brightnessDirection}`)} · {t(`encodeRoundTrip.assessment.${roundTripReport.assessment.tintDirection}`)} · {t(`encodeRoundTrip.assessment.${roundTripReport.assessment.differenceLevel}`)}</p>}
      <dl className="developer-diagnostics">
        {(['preEncode', 'decodedJpeg'] as const).map(side => <div key={side}><dt>{t(`encodeRoundTrip.${side}`)}</dt>
          <dd>{roundTripReport.dimensions[side] ? `${roundTripReport.dimensions[side]!.width} × ${roundTripReport.dimensions[side]!.height}` : '—'}</dd></div>)}
        {(['recipeVersion', 'quality', 'subsampling', 'outputColorSpace', 'sourceIcc'] as const).map(key => <div key={key}><dt>{t(`encodeRoundTrip.values.${key}`)}</dt>
          <dd>{roundTripReport[key] === null ? '—' : key === 'sourceIcc' ? t(`jpegDiagnostics.profileStatus.${roundTripReport.sourceIcc === 'embedded' ? 'embedded' : 'none'}`) : roundTripReport[key]}</dd></div>)}
        {Object.entries(roundTripReport.timing).map(([key, value]) => <div key={key}><dt>{t(`encodeRoundTrip.timing.${key}`)}</dt><dd>{value === null ? '—' : `${value.toFixed(2)} ms`}</dd></div>)}
      </dl>
      {roundTripReport.statistics && <><h4>{t('encodeRoundTrip.statistics')}</h4><dl className="developer-diagnostics">
        {DECODE_STATISTIC_KEYS.map(key => <div key={key}><dt>{t(`decodeCompare.values.${key}`)}</dt><dd>{roundTripReport.statistics![key].toFixed(6)}{key.endsWith('Percent') ? ' %' : ''}</dd></div>)}
      </dl></>}
    </section>
  </section>;
}

class EncodeRoundTripSafeError extends Error {
  constructor(readonly code: EncodeRoundTripErrorCode) { super(code); }
}
