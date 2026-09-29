import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { changeAppLanguage, currentLanguagePreference, SUPPORTED_LANGUAGES, type LanguagePreference } from './i18n';
import { DATE_LOCALES, updateSetting, useAppSettings, type DateLocale, type InitialImage, type WeekStart } from './appSettings';
import { useWorkspaceGpu, type GpuAvailability } from './useWorkspaceGpu';
import { WebGpuControl } from './WebGpuControl';

type GpuStatus = { enabled: boolean; availability: GpuAvailability; active: boolean; setPreference: (value: boolean) => void };
const SettingsContext = createContext({ open: () => {}, isOpen: false, publishGpu: (_value: GpuStatus | null) => {} });
export const useSettingsDialog = () => useContext(SettingsContext);
export function SettingsButton() {
  const { open } = useSettingsDialog(); const { t } = useTranslation();
  return <button type="button" className="tool-button settings-button" aria-label={t('settings.title')} title={t('settings.title')} onClick={open}>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.6-2 3.5 1.7 1.8v2L2.2 15l2 3.5 2.2-.6 2 .9L9 21h4l.6-2.2 2-.9 2.2.6 2-3.5-1.7-2v-2l1.7-1.8-2-3.5-2.2.6-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>
  </button>;
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [gpu, publishGpu] = useState<GpuStatus | null>(null);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return <SettingsContext.Provider value={{ open, isOpen, publishGpu }}>
    {children}
    {isOpen && <SettingsDialog gpu={gpu} onClose={close} />}
  </SettingsContext.Provider>;
}
function HomeGpuControl() {
  // A full pipeline probe is released immediately; Home never owns a live renderer.
  const gpu = useWorkspaceGpu('settings-home', true);
  return <WebGpuControl {...gpu} onChange={gpu.setPreference} />;
}
function ConnectionInformation() {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [backend, setBackend] = useState('checking');
  const [immich, setImmich] = useState('checking');
  const [about, setAbout] = useState<{ version?: string; build?: string; sourceRef?: string; error_code?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setBackend('checking'); setImmich('checking'); setAbout(null);
    async function load(path: string) {
      const response = await fetch(`/api/${path}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Connection request failed');
      return response.json();
    }
    void Promise.allSettled([
      load('health').then(data => { if (active) setBackend(data.status === 'ok' ? 'connected' : 'failed'); }).catch(() => { if (active) setBackend('failed'); }),
      load('immich/status').then(data => { if (active) setImmich(data.connected === true ? 'connected' : data.configured === false ? 'notConfigured' : 'failed'); }).catch(() => { if (active) setImmich('failed'); }),
      load('immich/about').then(data => {
        if (!data || typeof data !== 'object' || (typeof data.version !== 'string' && typeof data.error_code !== 'string')) throw new Error('Invalid server information');
        if (active) setAbout(data);
      }).catch(() => { if (active) setAbout({ error_code: 'unreachable' }); }),
    ]).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);
  return <>
    <h4>GenzoRoom</h4><p>{t('settings.development')}</p>
    <p role="status">Backend: {t(`connection.${backend}`)}</p>
    <h4>Immich</h4><p role="status">{t(`connection.${immich}`)}</p>
    {about ? about.error_code ? <p className="error-text" role="status">{t(about.error_code === 'authentication_failed' ? 'settings.aboutPermission' : 'settings.aboutFailed')}</p>
      : <dl>{(['version', 'build', 'sourceRef'] as const).map(key => typeof about[key] === 'string' && <div key={key}><dt>{t(`settings.${key}`)}</dt><dd>{about[key]}</dd></div>)}</dl>
      : <p role="status">{t('connection.checking')}</p>}
    <button type="button" className="tool-button" onClick={() => setAttempt(value => value + 1)}>{t('settings.refresh')}</button>
  </>;
}
export function SettingsDialog({ gpu, onClose }: { gpu: GpuStatus | null; onClose: () => void }) {
  const { t } = useTranslation(); const settings = useAppSettings();
  const [language, setLanguage] = useState(currentLanguagePreference);
  const dialog = useRef<HTMLDialogElement>(null); const title = useId();
  useLayoutEffect(() => {
    const element = dialog.current!; const previous = document.activeElement;
    element.showModal(); element.querySelector<HTMLElement>('button')?.focus();
    // Match existing modal isolation: native inertness alone does not stop window shortcuts.
    const blockOutside = (event: KeyboardEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockOutside, true); window.addEventListener('keyup', blockOutside, true);
    return () => {
      window.removeEventListener('keydown', blockOutside, true); window.removeEventListener('keyup', blockOutside, true);
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="settings-dialog" aria-modal="true" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header><h2 id={title}>{t('settings.title')}</h2><button type="button" className="tool-button" onClick={onClose}>{t('settings.close')}</button></header>
    <section aria-labelledby={`${title}-general`}><h3 id={`${title}-general`}>{t('settings.general')}</h3>
      <label>{t('language.label')}<select value={language} onChange={event => { const value = event.target.value as LanguagePreference; setLanguage(value); void changeAppLanguage(value); }}>
        <option value="auto">{t('settings.autoLanguage')}</option>
        {SUPPORTED_LANGUAGES.map(code => <option key={code} value={code}>{t('language.nativeName', { lng: code, defaultValue: code })}</option>)}
      </select></label>
      <label>{t('settings.dateLocale')}<select value={settings.dateLocale} onChange={event => updateSetting('dateLocale', event.target.value as DateLocale)}>
        <option value="auto">{t('settings.autoLocale')}</option>{DATE_LOCALES.map(locale => <option key={locale} value={locale}>{t(`settings.regions.${locale}`)}</option>)}
      </select></label>
      <label>{t('settings.weekStart')}<select value={settings.weekStart} onChange={event => updateSetting('weekStart', event.target.value as WeekStart)}>
        <option value="auto">{t('settings.autoWeek')}</option><option value="sunday">{t('settings.sunday')}</option><option value="monday">{t('settings.monday')}</option>
      </select></label>
    </section>
    <section aria-labelledby={`${title}-processing`}><h3 id={`${title}-processing`}>{t('settings.processing')}</h3>
      {gpu ? <WebGpuControl {...gpu} onChange={gpu.setPreference} /> : <HomeGpuControl />}
      <label>{t('settings.initialImage')}<select value={settings.initialImage} onChange={event => updateSetting('initialImage', event.target.value as InitialImage)}>
        <option value="auto">{t('settings.auto')}</option><option value="original">{t('settings.original')}</option><option value="preview">{t('settings.preview')}</option>
      </select></label>
    </section>
    <section aria-labelledby={`${title}-connection`}><h3 id={`${title}-connection`}>{t('settings.connection')}</h3><ConnectionInformation /></section>
  </dialog>;
}
