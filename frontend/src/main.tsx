import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { changeAppLanguage, type AppLanguage } from './i18n';
import { PhotoCard, type RecentAsset } from './PhotoCard';
import './style.css';

type Connection = 'checking' | 'connected' | 'error';
type ImmichConnection = Connection | 'not-configured';
type AssetState = 'loading' | 'ready' | 'error';

function App() {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const [connection, setConnection] = useState<Connection>('checking');
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);

    async function checkBackend() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Health request failed');
        const data: unknown = await response.json();
        if (
          typeof data !== 'object' || data === null ||
          !('status' in data) || data.status !== 'ok'
        ) throw new Error('Unexpected health response');
        if (active) setConnection('connected');
      } catch {
        if (active) setConnection('error');
      }
    }

    async function checkImmich() {
      try {
        const response = await fetch('/api/immich/status', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Immich status request failed');
        const data: unknown = await response.json();
        if (
          typeof data !== 'object' || data === null ||
          !('configured' in data) || typeof data.configured !== 'boolean' ||
          !('connected' in data) || typeof data.connected !== 'boolean'
        ) throw new Error('Unexpected Immich status response');

        if (!active) return;
        if (!data.configured) setImmichConnection('not-configured');
        else setImmichConnection(data.connected ? 'connected' : 'error');
      } catch {
        if (active) setImmichConnection('error');
      }
    }

    async function loadRecentAssets() {
      try {
        const response = await fetch('/api/assets/recent', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Recent assets request failed');
        const data: unknown = await response.json();
        if (!Array.isArray(data) || data.some((asset) => (
          typeof asset !== 'object' || asset === null ||
          !('id' in asset) || typeof asset.id !== 'string' ||
          !('filename' in asset) || typeof asset.filename !== 'string' ||
          !('date' in asset) || typeof asset.date !== 'string' ||
          !('thumbnail_url' in asset) || typeof asset.thumbnail_url !== 'string' ||
          !('format' in asset) || typeof asset.format !== 'string' ||
          !('is_raw' in asset) || typeof asset.is_raw !== 'boolean'
        ))) throw new Error('Unexpected recent assets response');

        if (active) {
          setAssets(data as RecentAsset[]);
          setAssetState('ready');
        }
      } catch {
        if (active) {
          setAssets([]);
          setAssetState('error');
        }
      }
    }

    void Promise.all([checkBackend(), checkImmich(), loadRecentAssets()]).finally(() => {
      window.clearTimeout(timeout);
    });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  const connectionDetail = connection === 'error'
    ? t('connection.backendFailedDetail')
    : immichConnection === 'not-configured'
      ? t('connection.notConfiguredDetail')
      : immichConnection === 'error'
        ? t('connection.immichFailedDetail')
        : immichConnection === 'connected'
          ? t('connection.succeededDetail')
          : t('connection.checkingDetail');

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">{t('app.eyebrow')}</p>
          <h1>{t('app.title')}</h1>
          <p className="stage">{t('app.statusLabel')}: {t('app.earlyDevelopment')}</p>
        </div>
        <div className="language-control">
          <label htmlFor="language-select">{t('language.label')}</label>
          <select
            id="language-select"
            value={language}
            onChange={(event) => void changeAppLanguage(event.target.value as AppLanguage)}
          >
            <option value="en">{t('language.english')}</option>
            <option value="ja">{t('language.japanese')}</option>
          </select>
        </div>
      </header>
      <section aria-label={t('connection.sectionLabel')}>
        <div className="status-list" role="status" aria-live="polite">
          <p className={`connection ${connection}`}>
            <span className="dot" aria-hidden="true" />
            {t('connection.backend')}: {
              connection === 'checking'
                ? t('connection.checking')
                : connection === 'connected'
                  ? t('connection.connected')
                  : t('connection.failed')
            }
          </p>
          <p className={`connection ${immichConnection}`}>
            <span className="dot" aria-hidden="true" />
            {t('connection.immich')}: {
              immichConnection === 'checking' ? t('connection.checking')
                : immichConnection === 'connected' ? t('connection.connected')
                  : immichConnection === 'not-configured' ? t('connection.notConfigured')
                    : t('connection.failed')
            }
          </p>
        </div>
        <p className="detail">{connectionDetail}</p>
        <button disabled={connection === 'checking' || immichConnection === 'checking' || assetState === 'loading'} onClick={() => {
          setConnection('checking');
          setImmichConnection('checking');
          setAssetState('loading');
          setAttempt((value) => value + 1);
        }}>
          {t('connection.checkAgain')}
        </button>
      </section>
      <section className="photos" aria-labelledby="recent-photos-heading">
        <h2 id="recent-photos-heading">{t('photos.recent')}</h2>
        {assetState === 'loading' ? (
          <p className="gallery-message" role="status">{t('photos.loading')}</p>
        ) : assetState === 'error' ? (
          <p className="gallery-message error-text" role="alert">{t('photos.loadFailed')}</p>
        ) : assets.length === 0 ? (
          <p className="gallery-message">{t('photos.empty')}</p>
        ) : (
          <div className="photo-grid">
            {assets.map((asset) => (
              <PhotoCard asset={asset} language={language} key={asset.id} />
            ))}
          </div>
        )}
      </section>
      <p className="note">{t('app.stageNotice')}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
