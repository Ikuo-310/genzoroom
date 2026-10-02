import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { WebGpuDiagnostics } from './WebGpuDiagnostics';
import './developer.css';

export function DeveloperPage() {
  const { t } = useTranslation();
  useEffect(() => {
    const original = document.title;
    document.title = `${t('developer.title')} — GenzoRoom`;
    return () => { document.title = original; };
  }, [t]);
  return <main className="developer-page">
    <header><p className="eyebrow">GenzoRoom</p><h1>{t('developer.title')}</h1><p>{t('developer.description')}</p></header>
    <WebGpuDiagnostics />
  </main>;
}
