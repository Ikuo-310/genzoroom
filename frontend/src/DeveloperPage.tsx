import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WebGpuDiagnostics } from './WebGpuDiagnostics';
import { RealJpegDiagnostics } from './RealJpegDiagnostics';
import { ExportEngineDiagnostics } from './ExportEngineDiagnostics';
import { DeveloperLogs } from './DeveloperLogsPanel';
import { frontendLogger } from './frontendLogging';
import { disableBackendLoggingOnExit } from './developerLogs';
import { emptyJpegReport, type JpegReport } from './jpegDiagnosticsReport';
import { collectDiagnosticsEnvironment, createDiagnosticsReport, createJpegDiagnosticsReport, createWebGpuDiagnosticsReport,
  createWebGpuReport, exportDiagnosticsReport, exportJpegDiagnosticsReport, exportWebGpuDiagnosticsReport, type WebGpuReport } from './developerDiagnostics';
import './developer.css';

const diagnosticTabs = ['logs', 'jpeg', 'webgpu', 'exportEngine'] as const;
type DiagnosticTab = typeof diagnosticTabs[number];

export function DeveloperPage() {
  const { t } = useTranslation();
  const [environment] = useState(collectDiagnosticsEnvironment);
  const [webgpu, setWebgpu] = useState(() => createWebGpuReport(environment.gpuApiAvailable, null));
  const [exportFailed, setExportFailed] = useState({ full: false, jpeg: false, webgpu: false });
  const [jpeg, setJpeg] = useState(emptyJpegReport);
  const [selectedTab, setSelectedTab] = useState<DiagnosticTab>('logs');
  const tabButtons = useRef<Partial<Record<DiagnosticTab, HTMLButtonElement | null>>>({});
  const loggingExitHandled = useRef(false);
  const acceptJpegReport = useCallback((report: JpegReport) => setJpeg(report), []);
  const acceptReport = useCallback((report: WebGpuReport) => setWebgpu(report), []);
  const selectTab = (tab: DiagnosticTab, focus = false) => {
    setSelectedTab(tab);
    if (focus) tabButtons.current[tab]?.focus();
  };
  const exportFull = () => {
    setExportFailed(value => ({ ...value, full: false }));
    try { exportDiagnosticsReport(createDiagnosticsReport(environment, webgpu, new Date(), jpeg)); }
    catch { setExportFailed(value => ({ ...value, full: true })); }
  };
  const exportJpeg = () => {
    setExportFailed(value => ({ ...value, jpeg: false }));
    try { exportJpegDiagnosticsReport(createJpegDiagnosticsReport(environment, jpeg)); }
    catch { setExportFailed(value => ({ ...value, jpeg: true })); }
  };
  const exportWebGpu = () => {
    setExportFailed(value => ({ ...value, webgpu: false }));
    try { exportWebGpuDiagnosticsReport(createWebGpuDiagnosticsReport(environment, webgpu)); }
    catch { setExportFailed(value => ({ ...value, webgpu: true })); }
  };
  useEffect(() => {
    const original = document.title;
    document.title = `${t('developer.title')} — GenzoRoom`;
    return () => { document.title = original; };
  }, [t]);
  useEffect(() => {
    loggingExitHandled.current = false;
    const disableLogging = () => {
      if (loggingExitHandled.current) return;
      loggingExitHandled.current = true;
      frontendLogger.setLevel('off');
      disableBackendLoggingOnExit();
    };
    window.addEventListener('pagehide', disableLogging);
    return () => {
      window.removeEventListener('pagehide', disableLogging);
      disableLogging();
    };
  }, []);
  const environmentValues = {
    secureContext: environment.secureContext, crossOriginIsolated: environment.crossOriginIsolated,
    gpuApiAvailable: environment.gpuApiAvailable, hardwareConcurrency: environment.hardwareConcurrency,
    deviceMemory: environment.deviceMemory, devicePixelRatio: environment.devicePixelRatio,
    viewportWidth: environment.viewport.width, viewportHeight: environment.viewport.height,
    userAgent: environment.userAgent, platform: environment.platform,
  };
  return <main className="developer-page">
    <header><p className="eyebrow">GenzoRoom</p><h1>{t('developer.title')}</h1><p>{t('developer.description')}</p></header>
    <section className="developer-section" aria-labelledby="environment-title">
      <h2 id="environment-title">{t('developer.environmentTitle')}</h2>
      <dl className="developer-diagnostics">{Object.entries(environmentValues).map(([key, value]) =>
        <div key={key}><dt>{t(`developer.environmentFields.${key}`)}</dt><dd>{value === null ? t('developer.notAvailable')
          : typeof value === 'boolean' ? t(`webgpuSmoke.${value ? 'yes' : 'no'}`) : value}</dd></div>)}</dl>
      <div className="developer-actions"><button type="button" onClick={exportFull}>{t('developer.exportJson')}</button></div>
      {exportFailed.full && <p role="alert">{t('developer.fullExportFailed')}</p>}
    </section>
    <div role="tablist" aria-label={t('developer.diagnosticTabs')} className="developer-tabs" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const focused = diagnosticTabs.find(tab => tabButtons.current[tab] === event.target) ?? selectedTab;
        const offset = event.key === 'ArrowLeft' ? -1 : 1;
        event.preventDefault(); selectTab(diagnosticTabs[(diagnosticTabs.indexOf(focused) + offset + diagnosticTabs.length) % diagnosticTabs.length], true);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); selectTab(event.key === 'Home' ? diagnosticTabs[0] : diagnosticTabs[diagnosticTabs.length - 1], true);
      }
    }}>
      {diagnosticTabs.map(tab => <button key={tab} ref={button => { tabButtons.current[tab] = button; }} id={`${tab}-tab`} role="tab" type="button" aria-selected={selectedTab === tab}
        aria-controls={`${tab}-panel`} tabIndex={selectedTab === tab ? 0 : -1} onClick={() => selectTab(tab)}>{t(`developer.${tab}Tab`)}</button>)}
    </div>
    <div id="logs-panel" role="tabpanel" aria-labelledby="logs-tab" tabIndex={0} hidden={selectedTab !== 'logs'}>
      <DeveloperLogs />
    </div>
    <div id="jpeg-panel" role="tabpanel" aria-labelledby="jpeg-tab" tabIndex={0} hidden={selectedTab !== 'jpeg'}>
      <RealJpegDiagnostics onReport={acceptJpegReport} onExport={exportJpeg} exportError={exportFailed.jpeg} />
    </div>
    <div id="webgpu-panel" role="tabpanel" aria-labelledby="webgpu-tab" tabIndex={0} hidden={selectedTab !== 'webgpu'}>
      <WebGpuDiagnostics onReport={acceptReport} onExport={exportWebGpu} exportError={exportFailed.webgpu} />
    </div>
    <div id="exportEngine-panel" role="tabpanel" aria-labelledby="exportEngine-tab" tabIndex={0} hidden={selectedTab !== 'exportEngine'}>
      <ExportEngineDiagnostics />
    </div>
  </main>;
}
