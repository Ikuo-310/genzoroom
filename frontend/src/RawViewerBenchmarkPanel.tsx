import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageViewer } from './ImageViewer';
import { downloadDiagnosticJson } from './diagnosticExport';
import { collectDiagnosticsEnvironment } from './diagnosticsEnvironment';
import { prepareRawTrial, stopRawDiagnostic, rawDiagnosticClosed, leaveRawDiagnostic, RawDiagnosticError } from './rawDiagnostics';
import { createRawViewerReport, fetchRawViewerTrial, startRawViewerBenchmark,
  type RawViewerRow, type RawViewerReport, type RawViewerMetadata, type RawViewerTrial, type RawViewerFailure } from './rawViewerBenchmark';
import { regionLayerPlacement, type RawRegionDisplay, type RawWholeSurface } from './rawRegionOverlay';

export const rawViewerDependencies = { start: startRawViewerBenchmark, prepare: prepareRawTrial, render: fetchRawViewerTrial,
  stop: stopRawDiagnostic, closed: rawDiagnosticClosed, leave: leaveRawDiagnostic };
type Surface = { url: string; metadata: RawViewerMetadata; base?: Surface; serial: number };
function regionDisplay(surface: Surface): RawRegionDisplay | undefined {
  const m = surface.metadata, r = m.region, base = surface.base;
  if (!r || !base) return;
  // Diagnostic-only ownership never escapes into the report or a production editing workspace.
  const doc = { workspaceId: 'diagnostic', handle: 'diagnostic', assetId: 'diagnostic', generation: 1,
    documentToken: 'diagnostic', revision: m.revision };
  const metadata = { contractVersion: 1 as const, mode: 'region' as const, quality: 'full' as const, kind: 'after' as const,
    geometryId: m.geometry.geometryId, fullWidth: r.fullWidth, fullHeight: r.fullHeight, window: r.window, validRegion: r.window,
    context: 0, prefetch: 0, identity: { assetId: doc.assetId, sourceId: 'diagnostic', generation: 1,
      documentToken: doc.documentToken, kind: 'after' as const, revision: m.revision }, documentRevision: m.revision,
    viewGeneration: m.viewGeneration, requestId: 'diagnostic', width: m.bitmap.width, height: m.bitmap.height };
  const whole: RawWholeSurface = { doc, url: base.url, frame: base.metadata.geometry, quality: 'full' };
  return { after: { url: surface.url, metadata, planGeneration: m.viewGeneration,
    ...regionLayerPlacement(metadata, m.geometry) }, wholeAfter: whole };
}

export function RawViewerBenchmark({ active, onReport, dependencies = rawViewerDependencies }: {
  active: boolean; onReport?: (report: RawViewerReport) => void; dependencies?: typeof rawViewerDependencies;
}) {
  const { t } = useTranslation();
  const [assetId, setAssetId] = useState(''), [backend, setBackend] = useState<'cpu' | 'gpu'>('gpu');
  const [rows, setRows] = useState<RawViewerRow[]>([]), [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null), [surface, setSurface] = useState<Surface | null>(null);
  const [fixedBackend, setFixedBackend] = useState<'cpu' | 'gpu'>('gpu');
  const [failure, setFailure] = useState<RawViewerFailure | null>(null);
  const owner = useRef<{ id?: string; controller: AbortController; stopped: boolean } | null>(null);
  const mounted = useRef(true), pendingAdopt = useRef<{ serial: number; resolve: () => void; reject: () => void } | null>(null);
  const urls = useRef(new Set<string>()), serial = useRef(0);
  const deps = useRef(dependencies); deps.current = dependencies;
  const report = createRawViewerReport(rows, status, fixedBackend, 3, failure);
  useEffect(() => { onReport?.(report); }, [rows, status, fixedBackend, failure, onReport]);
  useLayoutEffect(() => {
    if (surface && pendingAdopt.current?.serial === surface.serial) {
      pendingAdopt.current.resolve(); pendingAdopt.current = null;
    }
  }, [surface]);
  const release = () => { urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); };
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      const run = owner.current;
      if (run) { run.stopped = true; run.controller.abort(); if (run.id) deps.current.leave(run.id); }
      pendingAdopt.current?.reject(); pendingAdopt.current = null; release();
    };
    window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; leave(); window.removeEventListener('pagehide', leave); };
  }, []);
  const stop = () => {
    const run = owner.current;
    if (run) { run.stopped = true; if (run.id) void dependencies.stop(run.id).catch(() => {}); }
  };
  useEffect(() => { if (!active) stop(); }, [active]);
  const cleanup = async (run: NonNullable<typeof owner.current>) => {
    if (!run.id || await dependencies.stop(run.id)) return;
    const deadline = performance.now() + 180_000;
    while (performance.now() < deadline) {
      if (await dependencies.closed(run.id)) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new RawDiagnosticError('raw_diagnostic_cleanup_failed');
  };
  const start = async () => {
    if (owner.current || !active) return;
    const run = { id: undefined as string | undefined, controller: new AbortController(), stopped: false };
    owner.current = run; setStatus('running'); setError(null); setFailure(null); setRows([]); setFixedBackend(backend);
    let failed = false, whole: Surface | undefined;
    let currentTrial: RawViewerTrial | undefined;
    try {
      const started = await dependencies.start({ assetId, scenario: 'viewer', backend, repeats: 3 }, run.controller.signal);
      run.id = started.runId;
      for (const trial of started.plan) {
        currentTrial = trial;
        if (run.stopped) break;
        await dependencies.prepare(run.id, trial, run.controller.signal);
        if (run.stopped) break;
        const result = await dependencies.render(run.id, trial, run.controller.signal);
        if (run.stopped || run.controller.signal.aborted) break;
        const m = result.metadata;
        if (m.engine.gpuBackend !== (backend === 'cpu' ? 'off' : 'dx12')) throw new RawDiagnosticError('raw_invalid_response');
        if (trial.operation === 'regionPlan') {
          setRows(previous => [...previous, { metadata: m, responseWaitMs: result.responseWaitMs,
            transferMs: result.transferMs, decodeMs: null, adoptMs: null, totalMs: performance.now() - result.started }]);
          continue;
        }
        if (!result.blob) throw new RawDiagnosticError('raw_invalid_response');
        const url = URL.createObjectURL(result.blob); urls.current.add(url);
        const image = new Image(), decodeStarted = performance.now();
        const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(10_000)]);
        let removeAbort = () => {};
        try {
          image.src = url;
          await Promise.race([image.decode(), new Promise<never>((_, reject) => {
            const abort = () => reject(new RawDiagnosticError('raw_decode_cancelled'));
            signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort);
            if (signal.aborted) abort();
          })]);
          signal.throwIfAborted();
          if (image.naturalWidth !== m.bitmap.width || image.naturalHeight !== m.bitmap.height) throw new RawDiagnosticError('raw_invalid_response');
        } finally { removeAbort(); image.removeAttribute('src'); }
        if (run.stopped || !mounted.current) break;
        const decodeMs = performance.now() - decodeStarted, adoptStarted = performance.now();
        const next: Surface = { url, metadata: m, serial: ++serial.current, base: m.region ? whole : undefined };
        if (!m.region && m.operation !== 'before' && m.operation !== 'regionPlan') whole = next;
        await new Promise<void>((resolve, reject) => {
          pendingAdopt.current = { serial: next.serial, resolve, reject: () => reject(new RawDiagnosticError('raw_diagnostic_cancelled')) };
          setSurface(next);
        });
        if (run.stopped || !mounted.current) break;
        const retained = new Set([url, whole?.url]);
        for (const old of urls.current) if (!retained.has(old)) { URL.revokeObjectURL(old); urls.current.delete(old); }
        setRows(previous => [...previous, { metadata: m, responseWaitMs: result.responseWaitMs, transferMs: result.transferMs,
          decodeMs, adoptMs: performance.now() - adoptStarted,
          totalMs: performance.now() - result.started + (m.timing.openMs ?? 0) }]);
      }
    } catch (cause) {
      failed = !run.stopped && !run.controller.signal.aborted;
      if (mounted.current && failed) {
        const code = cause instanceof RawDiagnosticError ? cause.code : 'raw_diagnostic_failed';
        setError(code);
        setFailure({ operation: currentTrial?.operation ?? 'open', repeat: currentTrial?.repeat ?? 0, code });
      }
    } finally {
      if (mounted.current) setSurface(null);
      release();
      try { await cleanup(run); owner.current = null; if (mounted.current) setStatus(run.stopped ? 'cancelled' : failed ? 'failed' : 'complete'); }
      catch { if (mounted.current) { setStatus('cleanup_failed'); setError('raw_diagnostic_cleanup_failed'); } }
    }
  };
  const busy = status === 'running' || !!owner.current;
  const ms = (v: number | null) => v === null ? '—' : v.toFixed(2);
  const metadata = rows.at(-1)?.metadata;
  const lastRegion = [...rows].reverse().find(r => r.metadata.region)?.metadata;
  return <section className="developer-section">
    <h3>{t('rawViewerBenchmark.title')}</h3><p>{t('rawViewerBenchmark.description')}</p>
    <fieldset disabled={busy}><legend>{t('rawDiagnostics.conditions')}</legend>
      <label>{t('rawDiagnostics.assetId')} <input aria-label="RAW benchmark Asset ID" value={assetId} maxLength={36} onChange={event => setAssetId(event.target.value.trim())} /></label>
      <label>{t('rawDiagnostics.backend')} <select value={backend} onChange={event => setBackend(event.target.value as 'cpu' | 'gpu')}><option value="gpu">DX12</option><option value="cpu">CPU</option></select></label>
    </fieldset>
    <p>{t('rawViewerBenchmark.conditions')}</p>
    <div className="developer-actions">
      <button disabled={busy || !active || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(assetId)} onClick={() => void start()}>{t('rawViewerBenchmark.start')}</button>
      <button disabled={status !== 'running'} onClick={stop}>{t('rawDiagnostics.stop')}</button>
      <button disabled={busy || !rows.length} onClick={() => void downloadDiagnosticJson({ schemaVersion: 1, generatedAt: new Date().toISOString(),
        environment: collectDiagnosticsEnvironment(), rawPreview: { viewer: report } }, 'genzoroom-raw-preview').catch(() => setError('raw_diagnostic_export_failed'))}>{t('rawDiagnostics.export')}</button>
      {status === 'cleanup_failed' && <button onClick={() => { const run = owner.current; if (run) void cleanup(run).then(() => {
        owner.current = null; setStatus('cancelled'); setError(null);
      }).catch(() => setError('raw_diagnostic_cleanup_failed')); }}>{t('rawDiagnostics.retryCleanup')}</button>}
    </div>
    <p role="status">{t(`rawDiagnostics.phases.${status}`)}</p>{error && <p role="alert"><code>{error}</code></p>}
    {metadata && <dl className="developer-diagnostics">{Object.entries({ ...metadata.engine,
      native: `${metadata.geometry.nativeWidth} × ${metadata.geometry.nativeHeight}`, wholeRequestedSide: metadata.wholeRequestedSide,
      wholeActual: `${metadata.geometry.fullWidth} × ${metadata.geometry.fullHeight}`,
      region: lastRegion ? `${lastRegion.bitmap.width} × ${lastRegion.bitmap.height}` : '—',
      regionLimited: lastRegion?.region?.limited ?? '—', stageCache: metadata.stageCache.mode })
      .map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl>}
    {surface && <div style={{ width: 768, maxWidth: '100%', height: 640, pointerEvents: 'none' }}><ImageViewer src={surface.base?.url ?? surface.url} documentKey={`raw-diagnostic-${surface.metadata.repeat}`} rawFrame={surface.metadata.geometry}
      keyboardBlocked
      rawDiagnosticView={{ actual: ['regionPlan', 'regionFull', 'pan'].includes(surface.metadata.operation),
        nativePanX: surface.metadata.region ? surface.metadata.geometry.nativeWidth / 2
          - (surface.metadata.region.window.x + surface.metadata.region.window.w / 2) * surface.metadata.geometry.nativeWidth / surface.metadata.region.fullWidth : 0,
        nativePanY: surface.metadata.region ? surface.metadata.geometry.nativeHeight / 2
          - (surface.metadata.region.window.y + surface.metadata.region.window.h / 2) * surface.metadata.geometry.nativeHeight / surface.metadata.region.fullHeight : 0 }}
      rawRegionDisplay={regionDisplay(surface)} previewPixels alt="RAW Preview benchmark" leftOpen={false} rightOpen={false}
      onToggleLeft={() => {}} onToggleRight={() => {}} /></div>}
    <div className="developer-table-scroll"><table><caption>{t('rawViewerBenchmark.runs')}</caption>
      <thead><tr>{['operation', 'repeat', 'nativeMs', 'backendOperationMs', 'responseWaitMs', 'transferMs', 'decodeMs', 'adoptMs', 'totalMs'].map(key => <th key={key}>{key}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}><th>{row.metadata.operation}</th><td>{row.metadata.repeat}{row.metadata.warmup ? ' (warm-up)' : ''}</td>
        <td>{ms(row.metadata.timing.nativeMs)}</td><td>{ms(row.metadata.timing.backendOperationMs)}</td>
        {(['responseWaitMs', 'transferMs', 'decodeMs', 'adoptMs', 'totalMs'] as const).map(k => <td key={k}>{ms(row[k])}</td>)}</tr>)}</tbody>
    </table></div>
    <div className="developer-table-scroll"><table><caption>{t('rawDiagnostics.medianMinMax')}</caption>
      <thead><tr><th>operation</th>{['backendOperationMs', 'nativeMs', 'validationMs', 'responseWaitMs', 'transferMs', 'decodeMs', 'adoptMs', 'totalMs'].map(k => <th key={k}>{k}</th>)}</tr></thead>
      <tbody>{report.statistics.map(group => <tr key={group.operation}><th>{group.operation}</th>{Object.entries(group).filter(([k]) => k !== 'operation').map(([key, v]) => {
        const stat = v as { median: number | null; min: number | null; max: number | null; count: number };
        return <td key={key}>{ms(stat.median)} / {ms(stat.min)} / {ms(stat.max)} (n={stat.count})</td>;
      })}</tr>)}</tbody>
    </table></div><p>{t('rawViewerBenchmark.notes')}</p>
  </section>;
}
