import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Metadata = { url: string; keyConfigured: boolean; managed: boolean; pendingRestart: boolean;
  source: 'saved' | 'environment' | 'recovery'; error: string | null; cleanupPending: boolean };

export function WindowsConnectionSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [savedWithoutRestart, setSavedWithoutRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const request = new AbortController();
    void fetch('/__local/connection', { signal: request.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok) { setError(data.error); return; }
      setMetadata(data); setUrl(data.url); setError(data.error);
    }).catch(() => { if (mounted.current && !request.signal.aborted) setError('request_failed'); });
    return () => { mounted.current = false; request.abort(); controller.current?.abort(); };
  }, []);
  const editable = metadata?.managed === true && metadata.source !== 'environment';
  function restart() {
    onClose();
    // Close Settings before native Close preparation so its modal isolation cannot trap the save UI.
    window.requestAnimationFrame(() => {
      void window.__GENZOROOM_DESKTOP__?.respond({ kind: 'restart' }).catch(() => {
        window.dispatchEvent(new CustomEvent('genzoroom:close-cancelled', { detail: { code: 'backend_restart_failed' } }));
      });
    });
  }
  async function run(method: 'POST' | 'PUT' | 'DELETE') {
    if (busy) return;
    setBusy(true); setError(null); setSavedWithoutRestart(false);
    const request = new AbortController(); controller.current = request;
    const timeout = window.setTimeout(() => request.abort(), 15000);
    try {
      const response = await fetch('/__local/connection', { method, signal: request.signal,
        headers: method === 'DELETE' ? undefined : { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ url, apiKey }) });
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setTested(false); setError(data.error || 'request_failed');
        // A failed obsolete-credential cleanup may follow a successful atomic settings commit.
        const current = await fetch('/__local/connection', { cache: 'no-store', signal: request.signal });
        if (current.ok && mounted.current) setMetadata(await current.json());
        return;
      }
      setMetadata(data);
      if (method === 'POST') setTested(true);
      else {
        setApiKey(''); setTested(false);
        if (data.pendingRestart) restart();
        else setSavedWithoutRestart(true);
      }
    } catch { if (mounted.current) { setTested(false); setError('request_failed'); } }
    finally { window.clearTimeout(timeout); if (mounted.current) setBusy(false); }
  }
  const errorKey = error && t(`windowsConnection.errors.${error}`, { defaultValue: t('windowsConnection.errors.request_failed') });
  return <fieldset disabled={busy} className="settings-connection-group windows-connection-settings">
    <legend>{t('windowsConnection.title')}</legend>
    <p>{t(`windowsConnection.source.${metadata?.source ?? 'saved'}`)}</p>
    <label>{t('windowsConnection.url')}<input type="url" value={url} disabled={!editable} autoComplete="off"
      onChange={event => { setUrl(event.target.value); setTested(false); setSavedWithoutRestart(false); }} /></label>
    <label>{t('windowsConnection.key')}<input type="password" value={apiKey} disabled={!editable} autoComplete="off"
      placeholder={metadata?.keyConfigured ? t('windowsConnection.keySet') : ''}
      onChange={event => { setApiKey(event.target.value); setTested(false); setSavedWithoutRestart(false); }} /></label>
    <p role="status">{metadata?.keyConfigured ? t('windowsConnection.keySet') : t('windowsConnection.notSet')}</p>
    {!editable && metadata && <p>{t('windowsConnection.readOnly')}</p>}
    <p>{t('windowsConnection.scope')}</p>
    {tested && <p role="status">{t('windowsConnection.testPassed')}</p>}
    {savedWithoutRestart && <p role="status">{t('windowsConnection.savedWithoutRestart')}</p>}
    {metadata?.cleanupPending && <p role="status">{t('windowsConnection.cleanupPending')}</p>}
    {metadata?.pendingRestart && <p role="status">{t('windowsConnection.pendingRestart')}</p>}
    {errorKey && <p role="alert">{errorKey}</p>}
    <button type="button" className="tool-button" disabled={!editable || !url || (!apiKey && !metadata?.keyConfigured)} onClick={() => void run('POST')}>{t('windowsConnection.test')}</button>
    <button type="button" className="tool-button" disabled={!editable || !tested} onClick={() => void run('PUT')}>{t('windowsConnection.save')}</button>
    <button type="button" className="tool-button" disabled={!editable || (!metadata?.keyConfigured && !metadata?.cleanupPending)} onClick={() => void run('DELETE')}>{t('windowsConnection.delete')}</button>
    {metadata?.pendingRestart && <button type="button" className="tool-button" disabled={!editable || metadata.cleanupPending} onClick={restart}>{t('windowsConnection.restart')}</button>}
  </fieldset>;
}
