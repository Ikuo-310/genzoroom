import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadJsonReport } from './jsonReportDownload';
import { RawViewerBenchmark } from './RawViewerBenchmarkPanel';
import type { RawViewerReport } from './rawViewerBenchmark';
import { createRawDiagnosticReport, fetchRawTrial, leaveRawDiagnostic, prepareRawTrial, rawComparisons,
  rawDiagnosticClosed, rawStatistics, startRawDiagnostic, stopRawDiagnostic, RawDiagnosticError,
  type RawDiagnosticConfig, type RawTrialResult } from './rawDiagnostics';

export const rawDiagnosticDependencies = { start: startRawDiagnostic, prepare: prepareRawTrial, render: fetchRawTrial,
  stop: stopRawDiagnostic, closed: rawDiagnosticClosed, leave: leaveRawDiagnostic };
type Dependencies = typeof rawDiagnosticDependencies;
const defaults: RawDiagnosticConfig = { assetId: '', quality: 'both', stageCache: 'both', backend: 'cpu',
  temperature: 'both', repeats: 3, budgetBytes: 512 * 1024 ** 2 };

async function decode(blob: Blob, width: number, height: number, signal: AbortSignal) {
  const url = URL.createObjectURL(blob), image = new Image();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let remove = () => {};
  try {
    image.src = url;
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      const abort = () => reject(new RawDiagnosticError('raw_decode_cancelled'));
      bounded.addEventListener('abort', abort, { once: true });
      remove = () => bounded.removeEventListener('abort', abort);
      if (bounded.aborted) abort();
    })]);
    bounded.throwIfAborted();
    if (image.naturalWidth !== width || image.naturalHeight !== height) throw new RawDiagnosticError('raw_invalid_response');
  } finally { remove(); image.removeAttribute('src'); URL.revokeObjectURL(url); }
}

export function RawPreviewDiagnostics({ active = true, dependencies = rawDiagnosticDependencies, onViewerReport }: {
  active?: boolean; dependencies?: Dependencies; onViewerReport?: (report: RawViewerReport) => void;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(defaults);
  const [conditions, setConditions] = useState<RawDiagnosticConfig | null>(null);
  const [rows, setRows] = useState<RawTrialResult[]>([]);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'running' | 'stopping' | 'complete' | 'failed' | 'cancelled' | 'cleanup_failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const owner = useRef<{ id?: string; controller: AbortController; stopped: boolean } | null>(null);
  const mounted = useRef(true);
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const busy = ['preparing', 'running', 'stopping'].includes(phase);
  const stop = () => {
    const run = owner.current;
    if (!run) return;
    run.stopped = true;
    setPhase(previous => previous === 'cleanup_failed' ? previous : 'stopping');
    if (run.id) void dependencies.stop(run.id).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      const run = owner.current;
      if (!run) return;
      run.stopped = true;
      if (run.id) dependenciesRef.current.leave(run.id);
      run.controller.abort();
    };
    window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; leave(); window.removeEventListener('pagehide', leave); };
  }, []);
  useEffect(() => { if (!active) stop(); }, [active]);

  const cleanup = async (run: NonNullable<typeof owner.current>) => {
    if (!run.id) return;
    if (await dependencies.stop(run.id)) return;
    const deadline = performance.now() + 180_000;
    while (performance.now() < deadline) {
      if (await dependencies.closed(run.id)) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new RawDiagnosticError('raw_diagnostic_cleanup_failed');
  };
  const start = async () => {
    if (owner.current || !active) return;
    const run = { controller: new AbortController(), stopped: false, id: undefined as string | undefined };
    owner.current = run;
    const fixed = { ...config };
    setConditions(fixed); setRows([]); setError(null); setExportFailed(false); setPhase('preparing');
    let failed = false;
    try {
      const started = await dependencies.start(fixed, run.controller.signal);
      run.id = started.runId;
      for (const trial of started.plan) {
        if (run.stopped || run.controller.signal.aborted) break;
        if (mounted.current) setPhase('preparing');
        try {
          await dependencies.prepare(run.id, trial, run.controller.signal);
          if (run.stopped) break;
          if (mounted.current) setPhase('running');
          const result = await dependencies.render(run.id, trial, run.controller.signal);
          run.controller.signal.throwIfAborted();
          if (result.metadata.backend.configured !== fixed.backend || trial.stageCache === 'on'
            && result.metadata.metrics.stageCache.budgetBytes !== fixed.budgetBytes) throw new RawDiagnosticError('raw_invalid_response');
          const decodeStarted = performance.now();
          await decode(result.blob, result.metadata.width, result.metadata.height, run.controller.signal);
          const row: RawTrialResult = { trial, result: run.stopped ? 'cancelled' : 'success', metadata: result.metadata,
            responseWaitMs: result.responseWaitMs, transferMs: result.transferMs,
            decodeMs: performance.now() - decodeStarted, totalMs: performance.now() - result.started, errorCode: null };
          if (mounted.current) setRows(previous => [...previous, row]);
        } catch (cause) {
          const code = cause instanceof RawDiagnosticError ? cause.code : 'raw_diagnostic_failed';
          const result = run.stopped || run.controller.signal.aborted ? 'cancelled' : code === 'raw_preview_unsupported' ? 'unsupported' : 'failed';
          if (mounted.current) setRows(previous => [...previous, { trial, result, metadata: null, responseWaitMs: null,
            transferMs: null, decodeMs: null, totalMs: null, errorCode: code }]);
          throw cause;
        }
      }
    } catch (cause) {
      failed = !run.stopped && !run.controller.signal.aborted;
      if (mounted.current && failed) setError(cause instanceof RawDiagnosticError ? cause.code : 'raw_diagnostic_failed');
    } finally {
      try {
        await cleanup(run);
        if (owner.current === run) owner.current = null;
        if (mounted.current) setPhase(run.stopped ? 'cancelled' : failed ? 'failed' : 'complete');
      } catch {
        // Retain the owner on cleanup failure; a new run must not lose the old process/source.
        if (mounted.current) { setError('raw_diagnostic_cleanup_failed'); setPhase('cleanup_failed'); }
      }
    }
  };
  const retryCleanup = async () => {
    const run = owner.current;
    if (!run) return;
    setPhase('stopping');
    try { await cleanup(run); owner.current = null; setError(null); setPhase('cancelled'); }
    catch { setError('raw_diagnostic_cleanup_failed'); setPhase('cleanup_failed'); }
  };
  const ms = (n: number | null | undefined) => n == null ? t('rawDiagnostics.notCollected') : `${n.toFixed(2)} ms`;
  const comparisons = rawComparisons(rows), summaries = rawStatistics(rows);
  const update = <K extends keyof RawDiagnosticConfig>(key: K, value: RawDiagnosticConfig[K]) => setConfig(previous => ({ ...previous, [key]: value }));
  const select = (key: 'quality' | 'stageCache' | 'backend' | 'temperature', values: string[]) => <label>
    {t(`rawDiagnostics.${key}`)} <select value={config[key]} onChange={event => update(key, event.target.value as never)}>
      {values.map(value => <option key={value} value={value}>{t(`rawDiagnostics.values.${value}`)}</option>)}
    </select></label>;
  return <section className="developer-section raw-diagnostics" aria-labelledby="raw-preview-title">
    <h2 id="raw-preview-title">{t('rawDiagnostics.title')}</h2>
    <p>{t('rawDiagnostics.description')}</p><p>{t('rawDiagnostics.isolation')}</p>
    <fieldset disabled={busy || !!owner.current} className="raw-diagnostic-conditions">
      <legend>{t('rawDiagnostics.conditions')}</legend>
      <label>{t('rawDiagnostics.assetId')} <input value={config.assetId} spellCheck={false} maxLength={36}
        placeholder="00000000-0000-0000-0000-000000000000" onChange={event => update('assetId', event.target.value.trim())} /></label>
      {select('quality', ['draft', 'full', 'both'])}{select('stageCache', ['off', 'on', 'both'])}
      {select('backend', ['cpu', 'gpu'])}{select('temperature', ['cold', 'warm', 'both'])}
      <label>{t('rawDiagnostics.repeats')} <input type="number" min={1} max={5} step={1} value={config.repeats}
        onChange={event => update('repeats', Number(event.target.value))} /></label>
      <label>{t('rawDiagnostics.budget')} <input type="number" min={1} max={1024} step={1} value={config.budgetBytes / 1024 ** 2}
        onChange={event => update('budgetBytes', Number(event.target.value) * 1024 ** 2)} /></label>
    </fieldset>
    <p>{t('rawDiagnostics.coldWarm')}</p><p>{t('rawDiagnostics.limits')}</p>
    <div className="developer-actions">
      <button type="button" disabled={busy || !!owner.current || !active || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.assetId)
        || !Number.isInteger(config.repeats) || config.repeats < 1 || config.repeats > 5
        || !Number.isSafeInteger(config.budgetBytes) || config.budgetBytes < 1 || config.budgetBytes > 1024 ** 3}
        onClick={() => void start()}>{t('rawDiagnostics.start')}</button>
      <button type="button" disabled={!busy || phase === 'stopping'} onClick={stop}>{t('rawDiagnostics.stop')}</button>
      {phase === 'cleanup_failed' && <button type="button" onClick={() => void retryCleanup()}>{t('rawDiagnostics.retryCleanup')}</button>}
      <button type="button" disabled={!conditions || !rows.length || busy} onClick={() => {
        setExportFailed(false);
        void (async () => {
          try { await downloadJsonReport(createRawDiagnosticReport(conditions!, rows), 'genzoroom-raw-preview'); }
          catch { setExportFailed(true); }
        })();
      }}>{t('rawDiagnostics.export')}</button>
    </div>
    <p role="status">{t(`rawDiagnostics.phases.${phase}`)}</p>
    {error && <p role="alert">{t('rawDiagnostics.error')} <code>{error}</code></p>}
    {exportFailed && <p role="alert">{t('rawDiagnostics.exportFailed')}</p>}
    <div className="raw-diagnostic-table"><table>
      <caption>{t('rawDiagnostics.trials')}</caption>
      <thead><tr>{['quality', 'stageCache', 'temperature', 'backend', 'native', 'validation', 'transfer', 'decode', 'total', 'image', 'memory', 'result']
        .map(key => <th key={key}>{t(`rawDiagnostics.${key}`)}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.trial.index}>
        <td>{t(`rawDiagnostics.values.${row.trial.quality}`)}</td>
        <td>{t(`rawDiagnostics.values.${row.trial.stageCache}`)} / {row.metadata ? String(row.metadata.metrics.stageCache.applied) : t('rawDiagnostics.notCollected')}</td>
        <td>{t(`rawDiagnostics.values.${row.trial.temperature}`)} #{row.trial.repeat}</td>
        <td>{conditions?.backend.toUpperCase()} / {t(`rawDiagnostics.values.${row.metadata?.backend.execution ?? 'unconfirmed'}`)}
          {row.metadata?.backend.fallbackReported && ` (${t('rawDiagnostics.fallback')})`}</td>
        <td>{ms(row.metadata?.metrics.nativeMs)}</td><td>{ms(row.metadata?.metrics.validationMs)}</td><td>{ms(row.transferMs)}</td>
        <td>{ms(row.decodeMs)}</td><td>{ms(row.totalMs)}</td>
        <td>{row.metadata ? `${row.metadata.width} × ${row.metadata.height} / ${row.metadata.payloadBytes} B` : t('rawDiagnostics.notCollected')}</td>
        <td>{row.metadata ? `${row.metadata.metrics.stageCache.retainedBytes} B` : t('rawDiagnostics.notCollected')}<br />RSS / VRAM: {t('rawDiagnostics.notCollected')}</td>
        <td>{t(`rawDiagnostics.results.${row.result}`)}{row.errorCode && <code>{row.errorCode}</code>}</td>
      </tr>)}</tbody>
    </table></div>
    <h3>{t('rawDiagnostics.statistics')}</h3>
    <div className="raw-diagnostic-table"><table><caption>{t('rawDiagnostics.medianMinMax')}</caption>
      <thead><tr><th>{t('rawDiagnostics.conditions')}</th>{['native', 'validation', 'transfer', 'decode', 'total'].map(key => <th key={key}>{t(`rawDiagnostics.${key}`)}</th>)}</tr></thead>
      <tbody>{summaries.map(group => <tr key={group.condition}><th>{group.condition}</th>
        {(['nativeMs', 'validationMs', 'transferMs', 'decodeMs', 'totalMs'] as const).map(key => <td key={key}>
          {ms(group[key].median)} / {ms(group[key].min)} / {ms(group[key].max)} (n={group[key].count})</td>)}</tr>)}</tbody>
    </table></div>
    <p>{t('rawDiagnostics.ratioNotes')}</p>
    {!comparisons.ratios.length && <p>{t('rawDiagnostics.unverified')}</p>}
    {comparisons.ratios.map(r => <p key={`${r.comparison}:${r.temperature}:${r.fixed}`}>{t(`rawDiagnostics.${r.comparison}`)} / {r.temperature} / {r.fixed}: {r.ratio.toFixed(3)}×</p>)}
    <h3>{t('rawDiagnostics.fullMatch')}</h3>
    {!comparisons.matches.length && <p>{t('rawDiagnostics.unverified')}</p>}
    {comparisons.matches.map(m => <p key={`${m.temperature}:${m.repeat}`}>{m.temperature} #{m.repeat}: {t(`rawDiagnostics.matches.${m.result}`)}</p>)}
    <p>{t('rawDiagnostics.timingNotes')}</p><p>{t('rawDiagnostics.gpuNotes')}</p>
    <RawViewerBenchmark active={active && !busy && !owner.current} onReport={onViewerReport} />
  </section>;
}
