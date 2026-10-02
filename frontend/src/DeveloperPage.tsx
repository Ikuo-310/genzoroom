import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WebGpuDiagnostics } from './WebGpuDiagnostics';
import { collectDiagnosticsEnvironment, createDiagnosticsReport, createWebGpuReport, exportDiagnosticsReport, type WebGpuReport } from './developerDiagnostics';
import './developer.css';

export function DeveloperPage() {
  const { t } = useTranslation();
  const [environment] = useState(collectDiagnosticsEnvironment);
  const [webgpu, setWebgpu] = useState(() => createWebGpuReport(environment.gpuApiAvailable, null));
  const [exportFailed, setExportFailed] = useState(false);
  const acceptReport = useCallback((report: WebGpuReport) => setWebgpu(report), []);
  useEffect(() => {
    const original = document.title;
    document.title = `${t('developer.title')} — GenzoRoom`;
    return () => { document.title = original; };
  }, [t]);
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
    </section>
    <WebGpuDiagnostics onReport={acceptReport} />
    <section className="developer-section" aria-labelledby="diagnostic-export-title">
      <h2 id="diagnostic-export-title">{t('developer.exportTitle')}</h2>
      <button type="button" onClick={() => {
        setExportFailed(false);
        try { exportDiagnosticsReport(createDiagnosticsReport(environment, webgpu)); }
        catch { setExportFailed(true); }
      }}>{t('developer.exportJson')}</button>
      {exportFailed && <p role="alert">{t('developer.exportFailed')}</p>}
    </section>
  </main>;
}
