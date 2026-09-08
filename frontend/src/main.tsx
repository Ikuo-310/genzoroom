import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Connection = 'checking' | 'connected' | 'error';
type ImmichConnection = Connection | 'not-configured';

function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
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

    void Promise.all([checkBackend(), checkImmich()]).finally(() => {
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
        <button disabled={connection === 'checking' || immichConnection === 'checking'} onClick={() => {
          setConnection('checking');
          setImmichConnection('checking');
          setAttempt((value) => value + 1);
        }}>
          Check again
        </button>
      </section>
      <p className="note">This stage checks authenticated Immich connectivity only. Photo retrieval and editing are not available yet.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
