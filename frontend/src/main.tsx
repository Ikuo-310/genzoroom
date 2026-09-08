import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Connection = 'checking' | 'connected' | 'error';

function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 5000);

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
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkBackend();
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
        <p className={`connection ${connection}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          Backend: {connection === 'checking' ? 'Checking…' : connection === 'connected' ? 'Connected' : 'Connection failed'}
        </p>
        <p className="detail">
          {connection === 'error'
            ? 'The backend could not be reached or returned an invalid response. Check the services and try again.'
            : connection === 'connected'
              ? 'The last health check succeeded.'
              : 'Checking the backend health endpoint…'}
        </p>
        <button disabled={connection === 'checking'} onClick={() => {
          setConnection('checking');
          setAttempt((value) => value + 1);
        }}>
          Check again
        </button>
      </section>
      <p className="note">This first-stage scaffold checks connectivity only. Immich integration and photo editing are not available yet.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
