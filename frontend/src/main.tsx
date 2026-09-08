import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Connection = 'checking' | 'connected' | 'error';
type ImmichConnection = Connection | 'not-configured';
type AssetState = 'loading' | 'ready' | 'error';

type RecentAsset = {
  id: string;
  filename: string;
  date: string;
  thumbnail_url: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function App() {
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
          !('thumbnail_url' in asset) || typeof asset.thumbnail_url !== 'string'
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

  return (
    <main>
      <p className="eyebrow">A photo development room</p>
      <h1>GenzoRoom</h1>
      <p className="stage">Status: Early Development</p>
      <section aria-label="Backend connection">
        <div className="status-list" role="status" aria-live="polite">
          <p className={`connection ${connection}`}>
            <span className="dot" aria-hidden="true" />
            Backend: {connection === 'checking' ? 'Checking…' : connection === 'connected' ? 'Connected' : 'Connection failed'}
          </p>
          <p className={`connection ${immichConnection}`}>
            <span className="dot" aria-hidden="true" />
            Immich: {
              immichConnection === 'checking' ? 'Checking…'
                : immichConnection === 'connected' ? 'Connected'
                  : immichConnection === 'not-configured' ? 'Not configured'
                    : 'Connection failed'
            }
          </p>
        </div>
        <p className="detail">
          {connection === 'error'
            ? 'The backend could not be reached or returned an invalid response. Check the services and try again.'
            : immichConnection === 'not-configured'
              ? 'Set the Immich URL and API key in the backend environment.'
              : immichConnection === 'error'
                ? 'The backend could not verify the Immich connection. Check its configuration and logs.'
                : immichConnection === 'connected'
                  ? 'The backend and Immich connection checks succeeded.'
                  : 'Checking the backend and Immich connection…'}
        </p>
        <button disabled={connection === 'checking' || immichConnection === 'checking' || assetState === 'loading'} onClick={() => {
          setConnection('checking');
          setImmichConnection('checking');
          setAssetState('loading');
          setAttempt((value) => value + 1);
        }}>
          Check again
        </button>
      </section>
      <section className="photos" aria-labelledby="recent-photos-heading">
        <h2 id="recent-photos-heading">Recent photos</h2>
        {assetState === 'loading' ? (
          <p className="gallery-message" role="status">Loading photos…</p>
        ) : assetState === 'error' ? (
          <p className="gallery-message error-text" role="alert">Recent photos could not be loaded.</p>
        ) : assets.length === 0 ? (
          <p className="gallery-message">No photos found.</p>
        ) : (
          <div className="photo-grid">
            {assets.map((asset) => (
              <article className="photo-card" key={asset.id}>
                <img src={asset.thumbnail_url} alt={asset.filename} loading="lazy" />
                <div className="photo-info">
                  <p title={asset.filename}>{asset.filename}</p>
                  <time dateTime={asset.date}>{formatDate(asset.date)}</time>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="note">This stage displays up to 10 recent Immich photos. Photo editing is not available yet.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
