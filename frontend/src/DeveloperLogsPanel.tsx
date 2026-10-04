import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createFrontendLogsReport, exportFrontendLogsReport, frontendLogger, type LogLevel, type LogBufferStats } from './frontendLogging';
import { clearBackendLogs, createAllLogsReport, formatLogTimestamp, getBackendLogLevel, getBackendLogsReport,
  DeveloperLogsError, mergeLogEntries, setBackendLogLevel, type BackendLogEntry } from './developerLogs';
import { downloadJsonReport } from './jsonReportDownload';

type Scope = 'frontend' | 'backend' | 'all';
type BackendAction = 'load' | 'refresh' | 'level' | 'clear' | 'export';
const LOG_LEVEL_OPTIONS: readonly { value: LogLevel; label: string }[] = [
  { value: 'off', label: 'OFF' }, { value: 'info', label: 'INFO' }, { value: 'warn', label: 'WARN' },
  { value: 'error', label: 'ERROR' }, { value: 'debug', label: 'ALL (DEBUG)' },
];
export function DeveloperLogs() {
  const { t } = useTranslation();
  const [frontendLevel, setFrontendLevel] = useState(frontendLogger.getLevel);
  const [backendLevel, setBackendLevel] = useState<LogLevel | null>(null);
  const [frontend, setFrontend] = useState(frontendLogger.getEntries);
  const [backend, setBackend] = useState<BackendLogEntry[]>([]);
  const [frontendBuffer, setFrontendBuffer] = useState(frontendLogger.getBufferStats);
  const [backendBuffer, setBackendBuffer] = useState<LogBufferStats | undefined>();
  const [scope, setScope] = useState<Scope>('all');
  const [busy, setBusy] = useState<BackendAction | null>(null);
  const [levelError, setLevelError] = useState<string | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [frontendError, setFrontendError] = useState<string | null>(null);
  const [allError, setAllError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const failures = useRef(new Set<string>());

  function snapshotFrontend() {
    setFrontend(frontendLogger.getEntries()); setFrontendBuffer(frontendLogger.getBufferStats());
  }
  function failed(action: string, error: unknown) {
    // Record transitions into failure, not every unsuccessful refresh of the log endpoint itself.
    const code = error instanceof DeveloperLogsError ? error.code : 'operation_failed';
    if (frontendLogger.getLevel() === 'off' || frontendLogger.getLevel() === 'error') return;
    const key = `${action}:${code}`;
    if (failures.current.has(key)) return;
    failures.current.add(key);
    frontendLogger.add({ level: 'warn', component: 'developer_logs', event: 'operation.failed', context: {
      action, errorCode: code,
      ...(error instanceof DeveloperLogsError && Number.isFinite(error.httpStatus) ? { httpStatus: error.httpStatus! } : {}),
    } });
    snapshotFrontend();
  }
  function succeeded(action: string) {
    for (const key of failures.current) if (key.startsWith(`${action}:`)) failures.current.delete(key);
  }

  async function runBackend(action: BackendAction, work: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    // Serialize backend mutations and snapshots so a late refresh cannot undo a successful clear.
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    setBusy(action);
    try { await work(controller.signal, current); }
    finally { if (current()) { request.current = null; setBusy(null); } }
  }

  async function load(signal: AbortSignal, current: () => boolean, initial: boolean) {
    snapshotFrontend(); setFrontendLevel(frontendLogger.getLevel());
    setBackendError(null);
    const tasks: Promise<void>[] = [getBackendLogsReport(signal).then(report => {
      if (current()) { setBackend(report.entries); setBackendBuffer(report.buffer); succeeded('backend.logs'); }
    }).catch(error => { if (current()) { failed('backend.logs', error); setBackendError(initial ? 'logsUnavailable' : 'refreshFailed'); } })];
    if (initial || backendLevel === null) {
      setLevelError(null);
      tasks.push(getBackendLogLevel(signal).then(level => { if (current()) { setBackendLevel(level); succeeded('backend.level.get'); } })
        .catch(error => { if (current()) { failed('backend.level.get', error); setLevelError('levelUnavailable'); } }));
    }
    await Promise.all(tasks);
  }

  useEffect(() => {
    void runBackend('load', (signal, current) => load(signal, current, true));
    return () => { request.current?.abort(); request.current = null; };
  }, []);

  useEffect(() => frontendLogger.subscribe(() => {
    setFrontendLevel(frontendLogger.getLevel());
    snapshotFrontend();
  }), []);

  function changeFrontendLevel(value: LogLevel) { frontendLogger.setLevel(value); setFrontendLevel(value); }
  function changeBackendLevel(value: LogLevel) {
    void runBackend('level', async (signal, current) => {
      setLevelError(null);
      try { const level = await setBackendLogLevel(value, signal); if (current()) { setBackendLevel(level); succeeded('backend.level.set'); } }
      catch (error) { if (current()) { failed('backend.level.set', error); setLevelError('levelUpdateFailed'); } }
    });
  }
  function clearFrontend(): boolean {
    setFrontendError(null);
    try { frontendLogger.clear(); snapshotFrontend(); succeeded('frontend.clear'); return true; }
    catch (error) { failed('frontend.clear', error); setFrontendError('clearFailed'); return false; }
  }
  function clear(scope: Scope) {
    setAllError(null);
    const frontendOk = scope === 'backend' || clearFrontend();
    if (scope === 'frontend') return;
    void runBackend('clear', async (signal, current) => {
      setBackendError(null);
      try {
        await clearBackendLogs(signal);
        if (!current()) return;
        setBackend([]);
        setBackendBuffer(undefined); succeeded('backend.clear');
      } catch (error) {
        if (current()) { failed('backend.clear', error); setBackendError('clearFailed'); if (scope === 'all') setAllError('partialClearFailed'); }
        return;
      }
      if (!frontendOk && current()) setAllError('partialClearFailed');
      try { const report = await getBackendLogsReport(signal); if (current()) { setBackend(report.entries); setBackendBuffer(report.buffer); succeeded('backend.logs'); } }
      catch (error) { if (current()) { failed('backend.logs', error); setBackendError('logsUnavailable'); } }
    });
  }
  function exportLogs(scope: Scope) {
    setAllError(null);
    if (scope === 'frontend') {
      setFrontendError(null);
      try { exportFrontendLogsReport(createFrontendLogsReport(frontendLogger.getEntries(), new Date(), frontendLogger.getBufferStats())); succeeded('frontend.export'); }
      catch (error) { failed('frontend.export', error); setFrontendError('exportFailed'); }
      return;
    }
    void runBackend('export', async (signal, current) => {
      setBackendError(null);
      try {
        const report = await getBackendLogsReport(signal);
        if (!current()) return;
        if (scope === 'backend') downloadJsonReport(report, 'genzoroom-backend-logs');
        else downloadJsonReport(createAllLogsReport(frontendLogger.getEntries(), report, new Date(), frontendLogger.getBufferStats()), 'genzoroom-all-logs');
        succeeded(`${scope}.export`);
      } catch (error) {
        if (current()) { failed(`${scope}.export`, error); setBackendError('exportFailed'); if (scope === 'all') setAllError('allExportFailed'); }
      }
    });
  }
  const entries = scope === 'frontend' ? frontend : scope === 'backend' ? backend : mergeLogEntries(frontend, backend);
  const label = (value: Scope) => value === 'all' ? 'ALL' : value === 'frontend' ? 'Frontend' : 'Backend';
  return <section className="developer-logs" aria-label={t('developer.logsTab')}>
    <p className="developer-log-note">{t('developer.logs.autoOffNote')}</p>
    <div className="developer-log-controls">
      {(['frontend', 'backend'] as const).map(source => <section key={source} className="developer-section developer-log-card" aria-labelledby={`${source}-logs-title`}>
        <h2 id={`${source}-logs-title`}>{label(source)}</h2>
        <label className="developer-log-level">{t('developer.logs.level')}
          <select aria-label={`${label(source)} ${t('developer.logs.level')}`} value={(source === 'frontend' ? frontendLevel : backendLevel) ?? ''}
            disabled={source === 'backend' && (busy !== null || backendLevel === null)}
            onChange={event => source === 'frontend' ? changeFrontendLevel(event.target.value as LogLevel) : changeBackendLevel(event.target.value as LogLevel)}>
            {source === 'backend' && backendLevel === null && <option value="">{t('developer.notAvailable')}</option>}
            {LOG_LEVEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <div className="developer-actions">
          <button type="button" disabled={source === 'backend' && busy !== null} onClick={() => clear(source)}>{t('developer.logs.clear')}</button>
          <button type="button" disabled={source === 'backend' && busy !== null} onClick={() => exportLogs(source)}>{t('developer.logs.export')}</button>
        </div>
        {source === 'frontend' && frontendError && <p role="alert">{t(`developer.logs.frontend.${frontendError}`)}</p>}
        {source === 'backend' && levelError && <p role="alert">{t(`developer.logs.${levelError}`)}</p>}
        {source === 'backend' && backendError && <p role="alert">{t(`developer.logs.backend.${backendError}`)}</p>}
      </section>)}
      <div className="developer-log-common developer-actions">
        <button type="button" disabled={busy !== null} onClick={() => clear('all')}>{t('developer.logs.clearAll')}</button>
        <button type="button" disabled={busy !== null} onClick={() => exportLogs('all')}>{t('developer.logs.exportAll')}</button>
        {allError && <p role="alert">{t(`developer.logs.${allError}`)}</p>}
      </div>
    </div>
    {busy && <p role="status">{t('developer.logs.loading')}</p>}
    {frontendBuffer.droppedEntryCount > 0 && <p>{t('developer.logs.truncated', { source: 'Frontend', count: frontendBuffer.droppedEntryCount, capacity: frontendBuffer.capacity })}</p>}
    {backendBuffer && backendBuffer.droppedEntryCount > 0 && <p>{t('developer.logs.truncated', { source: 'Backend', count: backendBuffer.droppedEntryCount, capacity: backendBuffer.capacity })}</p>}
    <div className="developer-log-toolbar">
      <button type="button" disabled={busy !== null} onClick={() => void runBackend('refresh', (signal, current) => load(signal, current, false))}>{t('developer.logs.refresh')}</button>
      <div className="developer-log-sources" role="group" aria-label={t('developer.logs.source')}>
        {(['all', 'frontend', 'backend'] as const).map(value => <button type="button" key={value} aria-pressed={scope === value}
          onClick={() => setScope(value)}>{label(value)}</button>)}
      </div>
    </div>
    <div className="developer-log-console" role="region" aria-label={t('developer.logs.viewer')} tabIndex={0}>
      {entries.length === 0 ? <p>{t('developer.logs.empty')}</p> : entries.map((entry, index) => <div className="developer-log-line" key={index}>
        {`${formatLogTimestamp(entry.timestamp)}  ${entry.source === 'frontend' ? 'FE' : 'BE'}  ${entry.level.toUpperCase()}  ${entry.component}  ${entry.event}${entry.message === undefined ? '' : `  ${entry.message}`}${entry.context === undefined ? '' : `  ${JSON.stringify(entry.context)}`}`}
      </div>)}
    </div>
  </section>;
}
