import { SettingsButton } from './SettingsDialog';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchRecentAssets } from './api';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { type AppLanguage } from './i18n';
import { PhotoCard } from './PhotoCard';
import { useEditStatuses } from './useEditStatuses';
import { HomeTitle } from './HomeTitle';
import { PhotoFilterControls } from './PhotoFilterControls';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { RECENT_PHOTO_COUNTS, updateSetting, useAppSettings, type RecentPhotoCount } from './appSettings';
import { filterPhotos, photoFiltersForMode, readPhotoFilterMode, writePhotoFilterMode } from './photoFilters';
import {
  addVisiblePhotoRange,
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
  const settings = useAppSettings();
  const navigate = useNavigate();
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const [connection, setConnection] = useState<Connection>('checking');
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [photoFilterMode, setPhotoFilterMode] = useState(readPhotoFilterMode);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const connectionRequestId = useRef(0);
  const selectionAnchorId = useRef<string | null>(null);
  const hasLoadedRecentAssets = useRef(false);
  const editStatuses = useEditStatuses(assetState === 'ready' ? assets.map(asset => asset.id) : []);
  const photoFilters = photoFiltersForMode(photoFilterMode);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const requestId = ++connectionRequestId.current;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setConnection('checking');
    setImmichConnection('checking');

    async function checkBackend() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok || !isStatusOk(await response.json())) throw new Error('Invalid health response');
        if (active && connectionRequestId.current === requestId) setConnection('connected');
      } catch {
        if (active && connectionRequestId.current === requestId) setConnection('error');
      }
    }

    async function checkImmich() {
      try {
        const response = await fetch('/api/immich/status', { signal: controller.signal, cache: 'no-store' });
        const data: unknown = response.ok ? await response.json() : null;
        if (!isImmichStatus(data)) throw new Error('Invalid Immich response');
        if (!active || connectionRequestId.current !== requestId) return;
        if (!data.configured) setImmichConnection('not-configured');
        else setImmichConnection(data.connected ? 'connected' : 'error');
      } catch {
        if (active && connectionRequestId.current === requestId) setImmichConnection('error');
      }
    }

    void Promise.all([checkBackend(), checkImmich()]).finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [connectionAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    void fetchRecentAssets(settings.recentPhotoCount, controller.signal).then(data => {
      if (active) {
        hasLoadedRecentAssets.current = true;
        setAssets(data);
        const availableIds = new Set(data.map(asset => asset.id));
        setSelectedAssetIds(current => current.filter(id => availableIds.has(id)));
        if (selectionAnchorId.current && !availableIds.has(selectionAnchorId.current)) selectionAnchorId.current = null;
        setAssetState('ready');
      }
    }).catch(() => {
      if (active && !hasLoadedRecentAssets.current) {
        setAssets([]);
        setAssetState('error');
      }
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [settings.recentPhotoCount]);

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
      if (shouldClearSelectionOnEscape(event, true)) clearPhotoSelection();
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

  function togglePhotoSelection(assetId: string, extendRange = false) {
    const rangedSelection = extendRange
      ? addVisiblePhotoRange(selectedAssetIds, visibleAssets.map((asset) => asset.id), selectionAnchorId.current, assetId)
      : null;
    if (rangedSelection) {
      setSelectedAssetIds(rangedSelection);
      return;
    }
    const nextSelection = toggleSelectedAssetId(selectedAssetIds, assetId);
    selectionAnchorId.current = nextSelection.length > 0 ? assetId : null;
    setSelectedAssetIds(nextSelection);
  }

  function clearPhotoSelection() {
    selectionAnchorId.current = null;
    setSelectedAssetIds([]);
  }

  return (
    <main className="home-page">
      <div className="home-intro">
        <header className="app-header">
          <div>
            <div className="home-title-row">
              <h1><HomeTitle className="home-title-link" onActivate={() => {}} /></h1>
              <ConnectionStatusControl connection={connection} immichConnection={immichConnection} disabled={assetState === 'loading'}
                onCheckAgain={() => {
                  connectionRequestId.current += 1;
                  setConnection('checking');
                  setImmichConnection('checking');
                  setConnectionAttempt(value => value + 1);
                }} />
            </div>
            <p className="eyebrow">{t('app.eyebrow')}</p>
            <p className="stage">{t('app.statusLabel')}: {t('app.earlyDevelopment')}</p>
          </div>
          <SettingsButton />
        </header>
      </div>
      <section className="photos" aria-labelledby="recent-photos-heading">
        <div className="photos-heading">
          <h2 id="recent-photos-heading">{t('photos.recent')}</h2>
          <PhotoSelectionBar
            active={selectionMode}
            count={selectedAssetIds.length}
            onClear={clearPhotoSelection}
            onOpen={openSelectedAssets}
          />
          <div className="photos-heading-controls">
            <PhotoFilterControls filters={photoFilters} onChange={mode => {
              setPhotoFilterMode(mode);
              writePhotoFilterMode(mode);
            }} />
            <label className="home-control recent-count-control"><span className="home-control-label">{t('photos.recentCount')}</span>
              <select value={settings.recentPhotoCount}
                onChange={event => updateSetting('recentPhotoCount', Number(event.target.value) as RecentPhotoCount)}>
                {RECENT_PHOTO_COUNTS.map(count => <option key={count} value={count}>{t('photos.recentCountOption', { count })}</option>)}
              </select>
            </label>
            <div className="home-control thumbnail-size-setting">
              <span className="home-control-label">{t('photos.thumbnailSize')}</span>
              <HomeThumbnailSizeControl />
            </div>
          </div>
        </div>
        {assetState === 'loading' ? <p className="gallery-message" role="status">{t('photos.loading')}</p>
          : assetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('photos.loadFailed')}</p>
            : assets.length === 0 ? <p className="gallery-message">{t('photos.empty')}</p>
              : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                : <div className="photo-grid" style={{ '--photo-column-width': `calc(${100 / settings.homeThumbnailColumns}% - ${16 * (settings.homeThumbnailColumns - 1) / settings.homeThumbnailColumns}px)` } as CSSProperties}>{visibleAssets.map((asset) => (
                  <PhotoCard
                    asset={asset}
                    language={language}
                    key={asset.id}
                    selected={selectedAssetIds.includes(asset.id)}
                    selectionMode={selectionMode}
                    edited={editStatuses[asset.id]}
                    onToggleSelection={(extendRange) => togglePhotoSelection(asset.id, extendRange)}
                    onOpen={() => openWorkspace(asset)}
                  />
                ))}</div>}
      </section>
    </main>
  );
}

function ConnectionRow({ label, state }: { label: string; state: ImmichConnection }) {
  const { t } = useTranslation();
  const text = state === 'checking' ? t('connection.checking') : state === 'connected' ? t('connection.connected')
    : state === 'not-configured' ? t('connection.notConfigured') : t('connection.failed');
  return <p className={`connection ${state}`}><span className="dot" aria-hidden="true" />{label}: {text}</p>;
}

function ConnectionStatusControl({ connection, immichConnection, disabled, onCheckAgain }: {
  connection: Connection;
  immichConnection: ImmichConnection;
  disabled: boolean;
  onCheckAgain: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const overall = connection === 'checking' || immichConnection === 'checking' ? 'checking'
    : connection === 'error' || immichConnection === 'error' ? 'error'
      : immichConnection === 'not-configured' ? 'not-configured' : 'connected';
  const overallText = overall === 'checking' ? t('connection.checkingStatus')
    : overall === 'error' ? t('connection.failedStatus')
      : overall === 'not-configured' ? t('connection.notConfiguredStatus') : t('connection.connectedStatus');
  const connectionDetail = connection === 'error' ? t('connection.backendFailedDetail')
    : immichConnection === 'not-configured' ? t('connection.notConfiguredDetail')
      : immichConnection === 'error' ? t('connection.immichFailedDetail')
        : immichConnection === 'connected' ? t('connection.succeededDetail') : t('connection.checkingDetail');
  function handleDisclosureKey(event: ReactKeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (disclosure.current) disclosure.current.open = false;
    summary.current?.focus();
  }
  function handleSummaryKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (disclosure.current) disclosure.current.open = !disclosure.current.open;
  }
  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const current = disclosure.current;
      if (current?.open && event.target instanceof Node && !current.contains(event.target)) current.open = false;
    };
    // Capture only to close before the outside control acts; never cancel its pointer event or steal its focus.
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, []);
  return <details className={`connection-control ${overall}`} ref={disclosure} onKeyDown={handleDisclosureKey}>
    <summary ref={summary} onKeyDown={handleSummaryKey} aria-controls={detailsId} aria-label={t('connection.openDetails', { status: overallText })}>
      <span className="connection-symbol" aria-hidden="true">{overall === 'checking' ? '…' : overall === 'error' ? '!' : overall === 'not-configured' ? '–' : '✓'}</span>
      <span className="connection-overall-label">{overallText}</span>
    </summary>
    <section id={detailsId} className="connection-details" aria-label={t('connection.sectionLabel')}>
      <div className="status-list" role="status" aria-live="polite">
        <ConnectionRow label={t('connection.backend')} state={connection} />
        <ConnectionRow label={t('connection.immich')} state={immichConnection} />
      </div>
      <p className="detail">{connectionDetail}</p>
      <button type="button" disabled={connection === 'checking' || immichConnection === 'checking' || disabled}
        onClick={onCheckAgain}>{t('connection.checkAgain')}</button>
    </section>
  </details>;
}

function isStatusOk(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'status' in data && data.status === 'ok';
}

function isImmichStatus(data: unknown): data is { configured: boolean; connected: boolean } {
  return typeof data === 'object' && data !== null && 'configured' in data && typeof data.configured === 'boolean'
    && 'connected' in data && typeof data.connected === 'boolean';
}
