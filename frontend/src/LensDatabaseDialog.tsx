import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadRawLensDatabase, readRawLensDatabaseStatus, type RawLensDatabaseState } from './rawApi';

export function LensDatabaseDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [status, setStatus] = useState<RawLensDatabaseState | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>('button')?.focus();
    const blockOutside = (event: KeyboardEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockOutside, true);
    window.addEventListener('keyup', blockOutside, true);
    return () => {
      window.removeEventListener('keydown', blockOutside, true);
      window.removeEventListener('keyup', blockOutside, true);
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void readRawLensDatabaseStatus(controller.signal).then(value => {
      if (active) { setStatus(value); setError(false); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; controller.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (status?.download.state !== 'running') return;
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 500);
    return () => window.clearTimeout(timer);
  }, [status]);

  const download = async () => {
    if (starting || status?.download.state === 'running' || status?.userDirectoryConfigured) return;
    setStarting(true); setError(false);
    try {
      setStatus(await downloadRawLensDatabase());
    } catch {
      setError(true);
      setRefresh(value => value + 1);
    } finally { setStarting(false); }
  };

  const state = status?.download.state;
  const running = starting || state === 'running';
  const complete = state === 'done';
  const showProgress = state === 'running' && status?.download.bytes !== undefined && status.download.total !== undefined;
  const detail = showProgress && status!.download.bytes! < status!.download.total!
    ? t('lensDatabase.downloading', { done: status!.download.bytes!.toLocaleString(), total: status!.download.total!.toLocaleString() })
    : showProgress ? t('lensDatabase.verifying') : null;

  return <dialog ref={dialog} className="settings-dialog" aria-modal="true" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header><h2 id={title}>{t('lensDatabase.title')}</h2>
      <button type="button" className="tool-button" onClick={onClose}>{t('lensDatabase.close')}</button></header>
    <section aria-labelledby={`${title}-status`}>
      <h3 id={`${title}-status`}>{t('lensDatabase.statusTitle')}</h3>
      {!status && !error && <p role="status">{t('lensDatabase.checking')}</p>}
      {status && <>
        <p role="status">{status.available
          ? t('lensDatabase.available', { count: status.lensCount })
          : t('lensDatabase.notInstalled')}</p>
        {!status.available && <p>{t('lensDatabase.description')}</p>}
        {status.userDirectoryConfigured && <p>{t('lensDatabase.userDirectory')}</p>}
        {running && <p role="status">{detail ?? t('lensDatabase.starting')}</p>}
        {complete && <p role="status">{t('lensDatabase.completed')}</p>}
        {state === 'failed' && <p role="alert">{t('lensDatabase.failed')}</p>}
        {state === 'cancelled' && <p role="alert">{t('lensDatabase.cancelled')}</p>}
      </>}
      {error && <p role="alert">{t('lensDatabase.requestFailed')}</p>}
      {status?.available && complete && <p>{t('lensDatabase.reopen')}</p>}
      <div className="settings-dialog-actions">
        {error && !status && <button type="button" className="tool-button" onClick={() => { setError(false); setRefresh(value => value + 1); }}>
          {t('lensDatabase.retry')}
        </button>}
        {status && <button type="button" className="tool-button" disabled={running || status.userDirectoryConfigured}
          onClick={() => void download()}>
          {error ? t('lensDatabase.retry') : status.available ? t('lensDatabase.update') : t('lensDatabase.download')}
        </button>}
      </div>
    </section>
  </dialog>;
}
