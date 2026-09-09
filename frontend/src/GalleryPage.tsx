import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchRecentAssets } from './api';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { changeAppLanguage, type AppLanguage } from './i18n';
import { PhotoCard } from './PhotoCard';
import { PhotoFilterControls } from './PhotoFilterControls';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { DEFAULT_PHOTO_FILTERS, filterPhotos, togglePhotoFilter, type PhotoFilters } from './photoFilters';
import {
  blurPhotoSelectionCheckboxWhenSelectionEnds,
  createWorkspaceNavigation,
  resolveSelectedAssets,
  shouldClearSelectionOnEscape,
  toggleSelectedAssetId,
  workspacePath,
} from './photoSelection';

type Connection = 'checking' | 'connected' | 'error';
type ImmichConnection = Connection | 'not-configured';
type AssetState = 'loading' | 'ready' | 'error';

export function GalleryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const [connection, setConnection] = useState<Connection>('checking');
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [photoFilters, setPhotoFilters] = useState<PhotoFilters>(DEFAULT_PHOTO_FILTERS);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);

    async function checkBackend() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok || !isStatusOk(await response.json())) throw new Error('Invalid health response');
        if (active) setConnection('connected');
      } catch {
        if (active) setConnection('error');
      }
    }

    async function checkImmich() {
      try {
        const response = await fetch('/api/immich/status', { signal: controller.signal, cache: 'no-store' });
        const data: unknown = response.ok ? await response.json() : null;
        if (!isImmichStatus(data)) throw new Error('Invalid Immich response');
        if (!active) return;
        if (!data.configured) setImmichConnection('not-configured');
        else setImmichConnection(data.connected ? 'connected' : 'error');
      } catch {
        if (active) setImmichConnection('error');
      }
    }

    async function loadRecentAssets() {
      try {
        const data = await fetchRecentAssets(controller.signal);
        if (active) {
          setAssets(data);
          setAssetState('ready');
        }
      } catch {
        if (active) {
          setAssets([]);
          setAssetState('error');
        }
      }
    }

    void Promise.all([checkBackend(), checkImmich(), loadRecentAssets()]).finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  const connectionDetail = connection === 'error' ? t('connection.backendFailedDetail')
    : immichConnection === 'not-configured' ? t('connection.notConfiguredDetail')
      : immichConnection === 'error' ? t('connection.immichFailedDetail')
        : immichConnection === 'connected' ? t('connection.succeededDetail')
          : t('connection.checkingDetail');
  const visibleAssets = filterPhotos(assets, photoFilters);
  const selectedAssets = resolveSelectedAssets(assets, selectedAssetIds);
  const selectionMode = selectedAssetIds.length > 0;
  const previousSelectionMode = useRef(selectionMode);

  useLayoutEffect(() => {
    blurPhotoSelectionCheckboxWhenSelectionEnds(
      document.activeElement,
      previousSelectionMode.current,
      selectionMode,
    );
    previousSelectionMode.current = selectionMode;
  }, [selectionMode]);

  useEffect(() => {
    if (!selectionMode) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (shouldClearSelectionOnEscape(event, true)) setSelectedAssetIds([]);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectionMode]);

  function openWorkspace(asset: RecentAsset) {
    const state: WorkspaceNavigationState = { selectedAssets: [asset], activeAssetId: asset.id };
    navigate(workspacePath(asset.id), { state });
  }

  function openSelectedAssets() {
    const state = createWorkspaceNavigation(selectedAssets);
    if (state) navigate(workspacePath(state.activeAssetId), { state });
  }

  return (
    <main className="home-page">
      <header className="app-header">
        <div>
          <p className="eyebrow">{t('app.eyebrow')}</p>
          <h1>{t('app.title')}</h1>
          <p className="stage">{t('app.statusLabel')}: {t('app.earlyDevelopment')}</p>
        </div>
        <LanguageControl language={language} />
      </header>
      <section aria-label={t('connection.sectionLabel')}>
        <div className="status-list" role="status" aria-live="polite">
          <ConnectionRow label={t('connection.backend')} state={connection} />
          <ConnectionRow label={t('connection.immich')} state={immichConnection} />
        </div>
        <p className="detail">{connectionDetail}</p>
        <button disabled={connection === 'checking' || immichConnection === 'checking' || assetState === 'loading'} onClick={() => {
          setConnection('checking');
          setImmichConnection('checking');
          setAssetState('loading');
          setAttempt((value) => value + 1);
        }}>{t('connection.checkAgain')}</button>
      </section>
      <section className="photos" aria-labelledby="recent-photos-heading">
        <div className="photos-heading">
          <h2 id="recent-photos-heading">{t('photos.recent')}</h2>
          <PhotoSelectionBar
            active={selectionMode}
            count={selectedAssetIds.length}
            onClear={() => setSelectedAssetIds([])}
            onOpen={openSelectedAssets}
          />
          <PhotoFilterControls filters={photoFilters} onToggle={(filter) => setPhotoFilters((current) => togglePhotoFilter(current, filter))} />
        </div>
        {assetState === 'loading' ? <p className="gallery-message" role="status">{t('photos.loading')}</p>
          : assetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('photos.loadFailed')}</p>
            : assets.length === 0 ? <p className="gallery-message">{t('photos.empty')}</p>
              : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                : <div className="photo-grid">{visibleAssets.map((asset) => (
                  <PhotoCard
                    asset={asset}
                    language={language}
                    key={asset.id}
                    selected={selectedAssetIds.includes(asset.id)}
                    selectionMode={selectionMode}
                    onToggleSelection={() => setSelectedAssetIds((current) => toggleSelectedAssetId(current, asset.id))}
                    onOpen={() => openWorkspace(asset)}
                  />
                ))}</div>}
      </section>
      <p className="note">{t('app.stageNotice')}</p>
    </main>
  );
}

export function LanguageControl({ language, compact = false }: { language: AppLanguage; compact?: boolean }) {
  const { t } = useTranslation();
  const id = compact ? 'workspace-language-select' : 'language-select';
  return <div className={`language-control${compact ? ' compact' : ''}`}>
    <label htmlFor={id}>{t('language.label')}</label>
    <select id={id} value={language} onChange={(event) => void changeAppLanguage(event.target.value as AppLanguage)}>
      <option value="en">{t('language.english')}</option>
      <option value="ja">{t('language.japanese')}</option>
    </select>
  </div>;
}

function ConnectionRow({ label, state }: { label: string; state: ImmichConnection }) {
  const { t } = useTranslation();
  const text = state === 'checking' ? t('connection.checking') : state === 'connected' ? t('connection.connected')
    : state === 'not-configured' ? t('connection.notConfigured') : t('connection.failed');
  return <p className={`connection ${state}`}><span className="dot" aria-hidden="true" />{label}: {text}</p>;
}

function isStatusOk(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'status' in data && data.status === 'ok';
}

function isImmichStatus(data: unknown): data is { configured: boolean; connected: boolean } {
  return typeof data === 'object' && data !== null && 'configured' in data && typeof data.configured === 'boolean'
    && 'connected' in data && typeof data.connected === 'boolean';
}
