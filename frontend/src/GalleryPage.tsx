import { SettingsButton } from './SettingsDialog';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { homeScrollContent, readHomeReturn, restoreHomeScroll, type HomeReturnContext, type HomeTab } from './homeReturn';
import { fetchAlbumAssets, fetchAlbums, fetchCalendarDayAssets, fetchCalendarHeatmap, fetchRecentAssets } from './api';
import type { AlbumSummary } from './albums';
import { AlbumCard } from './AlbumCard';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { type AppLanguage } from './i18n';
import { PhotoCard } from './PhotoCard';
import { useEditStatuses } from './useEditStatuses';
import { HomeTitle } from './HomeTitle';
import { PhotoFilterControls } from './PhotoFilterControls';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { CALENDAR_FIRST_YEAR, CALENDAR_LAST_YEAR, HomeCalendar, type CalendarDay } from './HomeCalendar';
import { RECENT_PHOTO_COUNTS, resolveDateLocale, resolveWeekStart, updateSetting, useAppSettings, type RecentPhotoCount } from './appSettings';
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
  const location = useLocation();
  const [homeReturn] = useState(() => readHomeReturn(location.state?.homeReturn));
  const pageRef = useRef<HTMLElement>(null);
  const pendingScroll = useRef(homeReturn);
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const [connection, setConnection] = useState<Connection>('checking');
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [activeTab, setActiveTab] = useState<HomeTab>(homeReturn?.tab ?? 'recent');
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [albumState, setAlbumState] = useState<'idle' | AssetState>('idle');
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumSummary | null>(homeReturn?.album ?? null);
  const [albumAssets, setAlbumAssets] = useState<RecentAsset[]>([]);
  const [albumAssetState, setAlbumAssetState] = useState<'idle' | AssetState>('idle');
  const [calendarYear, setCalendarYear] = useState(() => homeReturn?.year ?? new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => homeReturn?.month ?? new Date().getMonth() + 1);
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([]);
  const [calendarState, setCalendarState] = useState<'idle' | AssetState>('idle');
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(homeReturn?.date ?? null);
  const [calendarAssets, setCalendarAssets] = useState<RecentAsset[]>([]);
  const [calendarAssetState, setCalendarAssetState] = useState<'idle' | AssetState>('idle');
  const [photoFilterMode, setPhotoFilterMode] = useState(readPhotoFilterMode);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [albumSelectedAssetIds, setAlbumSelectedAssetIds] = useState<string[]>([]);
  const [calendarSelectedAssetIds, setCalendarSelectedAssetIds] = useState<string[]>([]);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const connectionRequestId = useRef(0);
  const selectionAnchorId = useRef<string | null>(null);
  const albumSelectionAnchorId = useRef<string | null>(null);
  const calendarSelectionAnchorId = useRef<string | null>(null);
  const albumAssetRequestId = useRef(0);
  const calendarHeatmapRequestId = useRef(0);
  const calendarAssetRequestId = useRef(0);
  const hasLoadedRecentAssets = useRef(false);
  const hasLoadedAlbums = useRef(false);
  const recentTab = useRef<HTMLButtonElement>(null);
  const albumsTab = useRef<HTMLButtonElement>(null);
  const calendarTab = useRef<HTMLButtonElement>(null);
  const showingAlbumPhotos = activeTab === 'albums' && selectedAlbum !== null;
  const showingCalendarPhotos = activeTab === 'calendar' && selectedCalendarDate !== null;
  const editStatusAssets = activeTab === 'recent' && assetState === 'ready' ? assets
    : showingAlbumPhotos && albumAssetState === 'ready' ? albumAssets
      : showingCalendarPhotos && calendarAssetState === 'ready' ? calendarAssets : [];
  const editStatuses = useEditStatuses(editStatusAssets.map(asset => asset.id));
  const photoFilters = photoFiltersForMode(photoFilterMode);

  useLayoutEffect(() => {
    const context = pendingScroll.current;
    if (!context || !pageRef.current) return;
    // Never apply an old offset if the user changes views before the restored request completes.
    if (context.tab !== activeTab || context.album?.id !== selectedAlbum?.id
      || context.date !== selectedCalendarDate || context.year !== calendarYear || context.month !== calendarMonth) {
      pendingScroll.current = null;
      return;
    }
    const status = activeTab === 'recent' ? assetState : activeTab === 'albums'
      ? selectedAlbum ? albumAssetState : albumState : selectedCalendarDate ? calendarAssetState : calendarState;
    if (status === 'idle' || status === 'loading') return;
    // Card dimensions are established by CSS, so restoration can run after the data's DOM commit.
    restoreHomeScroll(pageRef.current, context);
    pendingScroll.current = null;
  }, [activeTab, selectedAlbum, selectedCalendarDate, calendarYear, calendarMonth,
    assetState, albumState, albumAssetState, calendarState, calendarAssetState]);

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

  useEffect(() => {
    // Returning from an album detail should reuse the already loaded list.
    if (activeTab !== 'albums' || hasLoadedAlbums.current) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    if (!hasLoadedAlbums.current) setAlbumState('loading');
    void fetchAlbums(controller.signal).then(data => {
      if (!active) return;
      hasLoadedAlbums.current = true;
      setAlbums(data);
      setAlbumState('ready');
    }).catch(() => {
      if (active && !hasLoadedAlbums.current) setAlbumState('error');
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'albums' || selectedAlbum === null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = albumAssetRequestId.current;
    void fetchAlbumAssets(selectedAlbum.id, controller.signal).then(data => {
      if (!active || requestId !== albumAssetRequestId.current) return;
      const availableIds = new Set(data.map(asset => asset.id));
      setAlbumAssets(data);
      setAlbumSelectedAssetIds(current => current.filter(id => availableIds.has(id)));
      if (albumSelectionAnchorId.current && !availableIds.has(albumSelectionAnchorId.current)) albumSelectionAnchorId.current = null;
      setAlbumAssetState('ready');
    }).catch(() => {
      if (active && requestId === albumAssetRequestId.current) setAlbumAssetState('error');
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, selectedAlbum?.id]);

  useEffect(() => {
    if (activeTab !== 'calendar' || selectedCalendarDate !== null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = ++calendarHeatmapRequestId.current;
    setCalendarState('loading');
    void fetchCalendarHeatmap(calendarYear, calendarMonth, controller.signal).then(data => {
      if (!active || requestId !== calendarHeatmapRequestId.current) return;
      setCalendarDays(data.days);
      setCalendarState('ready');
    }).catch(() => {
      if (active && requestId === calendarHeatmapRequestId.current) setCalendarState('error');
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, calendarYear, calendarMonth, selectedCalendarDate]);

  useEffect(() => {
    if (activeTab !== 'calendar' || selectedCalendarDate === null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = calendarAssetRequestId.current;
    void fetchCalendarDayAssets(selectedCalendarDate, controller.signal).then(data => {
      if (!active || requestId !== calendarAssetRequestId.current) return;
      setCalendarAssets(data);
      const availableIds = new Set(data.map(asset => asset.id));
      setCalendarSelectedAssetIds(current => current.filter(id => availableIds.has(id)));
      if (calendarSelectionAnchorId.current && !availableIds.has(calendarSelectionAnchorId.current)) calendarSelectionAnchorId.current = null;
      setCalendarAssetState('ready');
    }).catch(() => {
      if (active && requestId === calendarAssetRequestId.current) setCalendarAssetState('error');
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, selectedCalendarDate]);

  // Each grid owns its selection so shared asset IDs cannot carry a selection across views.
  const currentAssets = showingCalendarPhotos ? calendarAssets : showingAlbumPhotos ? albumAssets : assets;
  const activeSelectedAssetIds = showingCalendarPhotos ? calendarSelectedAssetIds : showingAlbumPhotos ? albumSelectedAssetIds : selectedAssetIds;
  const visibleAssets = filterPhotos(currentAssets, photoFilters);
  const selectedAssets = resolveSelectedAssets(currentAssets, activeSelectedAssetIds);
  const selectionMode = (activeTab === 'recent' || showingAlbumPhotos && albumAssetState === 'ready' ||
    showingCalendarPhotos && calendarAssetState === 'ready') && activeSelectedAssetIds.length > 0;
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
    const state: WorkspaceNavigationState = { selectedAssets: [asset], activeAssetId: asset.id, homeReturn: captureHomeReturn() };
    navigate(workspacePath(asset.id), { state });
  }

  function openSelectedAssets() {
    const state = createWorkspaceNavigation(selectedAssets);
    if (state) navigate(workspacePath(state.activeAssetId), { state: { ...state, homeReturn: captureHomeReturn() } });
  }

  function captureHomeReturn(): HomeReturnContext {
    const page = pageRef.current;
    return { tab: activeTab, album: selectedAlbum, year: calendarYear, month: calendarMonth,
      date: selectedCalendarDate, pageScrollTop: page?.scrollTop ?? 0,
      contentScrollTop: page ? homeScrollContent(page)?.scrollTop ?? 0 : 0 };
  }

  function togglePhotoSelection(assetId: string, extendRange = false) {
    const rangedSelection = extendRange
      ? addVisiblePhotoRange(activeSelectedAssetIds, visibleAssets.map((asset) => asset.id),
        showingCalendarPhotos ? calendarSelectionAnchorId.current
          : showingAlbumPhotos ? albumSelectionAnchorId.current : selectionAnchorId.current, assetId)
      : null;
    if (rangedSelection) {
      if (showingCalendarPhotos) setCalendarSelectedAssetIds(rangedSelection);
      else if (showingAlbumPhotos) setAlbumSelectedAssetIds(rangedSelection);
      else setSelectedAssetIds(rangedSelection);
      return;
    }
    const nextSelection = toggleSelectedAssetId(activeSelectedAssetIds, assetId);
    if (showingCalendarPhotos) {
      calendarSelectionAnchorId.current = nextSelection.length > 0 ? assetId : null;
      setCalendarSelectedAssetIds(nextSelection);
    } else if (showingAlbumPhotos) {
      albumSelectionAnchorId.current = nextSelection.length > 0 ? assetId : null;
      setAlbumSelectedAssetIds(nextSelection);
    } else {
      selectionAnchorId.current = nextSelection.length > 0 ? assetId : null;
      setSelectedAssetIds(nextSelection);
    }
  }

  function clearPhotoSelection() {
    if (showingCalendarPhotos) {
      calendarSelectionAnchorId.current = null;
      setCalendarSelectedAssetIds([]);
    } else if (showingAlbumPhotos) {
      albumSelectionAnchorId.current = null;
      setAlbumSelectedAssetIds([]);
    } else {
      selectionAnchorId.current = null;
      setSelectedAssetIds([]);
    }
  }

  function openAlbum(album: AlbumSummary) {
    // Invalidate the previous request before React runs its effect cleanup.
    albumAssetRequestId.current += 1;
    albumSelectionAnchorId.current = null;
    setAlbumSelectedAssetIds([]);
    setAlbumAssets([]);
    setAlbumAssetState('loading');
    setSelectedAlbum(album);
  }

  function closeAlbum() {
    albumAssetRequestId.current += 1;
    albumSelectionAnchorId.current = null;
    setAlbumSelectedAssetIds([]);
    setAlbumAssets([]);
    setAlbumAssetState('idle');
    setSelectedAlbum(null);
  }

  function changeCalendarYear(year: number) {
    if (year < CALENDAR_FIRST_YEAR || year > CALENDAR_LAST_YEAR) return;
    calendarHeatmapRequestId.current += 1;
    setCalendarYear(year);
  }

  function changeCalendarMonth(month: number) {
    if (month < 1 || month > 12) return;
    calendarHeatmapRequestId.current += 1;
    setCalendarMonth(month);
  }

  function openCalendarDay(day: string) {
    calendarAssetRequestId.current += 1;
    calendarSelectionAnchorId.current = null;
    setCalendarSelectedAssetIds([]);
    setCalendarAssets([]);
    setCalendarAssetState('loading');
    setSelectedCalendarDate(day);
  }

  function closeCalendarDay() {
    calendarAssetRequestId.current += 1;
    calendarSelectionAnchorId.current = null;
    setCalendarSelectedAssetIds([]);
    setCalendarAssets([]);
    setCalendarAssetState('idle');
    setSelectedCalendarDate(null);
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs: HomeTab[] = ['recent', 'albums', 'calendar'];
    const index = tabs.indexOf(activeTab);
    const next: HomeTab = event.key === 'Home' ? 'recent' : event.key === 'End' ? 'calendar'
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    setActiveTab(next);
    (next === 'recent' ? recentTab : next === 'albums' ? albumsTab : calendarTab).current?.focus();
  }

  function renderPhotoGrid() {
    return <div className="photo-grid" style={{ '--photo-column-width': `calc(${100 / settings.homeThumbnailColumns}% - ${16 * (settings.homeThumbnailColumns - 1) / settings.homeThumbnailColumns}px)` } as CSSProperties}>{visibleAssets.map((asset) => (
      <PhotoCard
        asset={asset}
        language={language}
        key={asset.id}
        selected={activeSelectedAssetIds.includes(asset.id)}
        selectionMode={selectionMode}
        edited={editStatuses[asset.id]}
        onToggleSelection={(extendRange) => togglePhotoSelection(asset.id, extendRange)}
        onOpen={() => openWorkspace(asset)}
      />
    ))}</div>;
  }

  return (
    <main className="home-page" ref={pageRef}>
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
      <section className="photos" aria-label={t('home.sections')}>
        <div className="home-toolbar">
          <div className="home-tabs" role="tablist" aria-label={t('home.sections')}>
            <button id="home-recent-tab" ref={recentTab} type="button" role="tab" aria-controls="home-recent-panel"
              aria-selected={activeTab === 'recent'} tabIndex={activeTab === 'recent' ? 0 : -1}
              onClick={() => setActiveTab('recent')} onKeyDown={handleTabKeyDown}>{t('home.recentTab')}</button>
            <button id="home-albums-tab" ref={albumsTab} type="button" role="tab" aria-controls="home-albums-panel"
              aria-selected={activeTab === 'albums'} tabIndex={activeTab === 'albums' ? 0 : -1}
              onClick={() => setActiveTab('albums')} onKeyDown={handleTabKeyDown}>{t('home.albumsTab')}</button>
            <button id="home-calendar-tab" ref={calendarTab} type="button" role="tab" aria-controls="home-calendar-panel"
              aria-selected={activeTab === 'calendar'} tabIndex={activeTab === 'calendar' ? 0 : -1}
              onClick={() => setActiveTab('calendar')} onKeyDown={handleTabKeyDown}>{t('home.calendarTab')}</button>
          </div>
          <div className="home-toolbar-controls">
            {(activeTab === 'recent' || showingAlbumPhotos || showingCalendarPhotos) && <PhotoFilterControls filters={photoFilters} onChange={mode => {
              setPhotoFilterMode(mode);
              writePhotoFilterMode(mode);
            }} />}
            {activeTab === 'recent' && <>
              <label className="home-control recent-count-control"><span className="home-control-label">{t('photos.recentCount')}</span>
                <select value={settings.recentPhotoCount}
                  onChange={event => updateSetting('recentPhotoCount', Number(event.target.value) as RecentPhotoCount)}>
                  {RECENT_PHOTO_COUNTS.map(count => <option key={count} value={count}>{t('photos.recentCountOption', { count })}</option>)}
                </select>
              </label>
            </>}
            {(activeTab !== 'calendar' || showingCalendarPhotos) && <div className="home-control thumbnail-size-setting">
              <span className="home-control-label">{t('photos.thumbnailSize')}</span>
              <HomeThumbnailSizeControl />
            </div>}
          </div>
        </div>
        {activeTab === 'recent' ? <div id="home-recent-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-recent-tab">
        {selectionMode && <PhotoSelectionBar
          active={selectionMode}
          count={activeSelectedAssetIds.length}
          onClear={clearPhotoSelection}
          onOpen={openSelectedAssets}
        />}
        {assetState === 'loading' ? <p className="gallery-message" role="status">{t('photos.loading')}</p>
          : assetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('photos.loadFailed')}</p>
            : assets.length === 0 ? <p className="gallery-message">{t('photos.empty')}</p>
              : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                : renderPhotoGrid()}
        </div> : activeTab === 'albums' ? <div id="home-albums-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-albums-tab">
          {selectedAlbum ? <>
            <div className="album-detail-heading">
              <button type="button" className="album-back" onClick={closeAlbum}>← {t('albums.backToList')}</button>
              <h2>{selectedAlbum.albumName}</h2>
            </div>
            {selectionMode && <PhotoSelectionBar active count={activeSelectedAssetIds.length}
              onClear={clearPhotoSelection} onOpen={openSelectedAssets} />}
            {albumAssetState === 'idle' || albumAssetState === 'loading'
              ? <p className="gallery-message" role="status">{t('albums.photosLoading')}</p>
              : albumAssetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('albums.photosLoadFailed')}</p>
                : albumAssets.length === 0 ? <p className="gallery-message">{t('albums.photosEmpty')}</p>
                  : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                    : renderPhotoGrid()}
          </> : albumState === 'idle' || albumState === 'loading'
            ? <p className="gallery-message" role="status">{t('albums.loading')}</p>
            : albumState === 'error' ? <p className="gallery-message error-text" role="alert">{t('albums.loadFailed')}</p>
              : albums.length === 0 ? <p className="gallery-message">{t('albums.empty')}</p>
                : <div className="album-grid" style={{ '--album-column-width': `calc(${100 / settings.homeThumbnailColumns}% - ${16 * (settings.homeThumbnailColumns - 1) / settings.homeThumbnailColumns}px)` } as CSSProperties}>{albums.map(album => <AlbumCard key={album.id} album={album} onOpen={() => openAlbum(album)} />)}</div>}
        </div> : <div id="home-calendar-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-calendar-tab">
          {selectedCalendarDate ? <>
            <div className="album-detail-heading">
              <button type="button" className="album-back" onClick={closeCalendarDay}>← {t('calendar.backToMonth')}</button>
              <h2>{new Intl.DateTimeFormat(resolveDateLocale(settings.dateLocale), { dateStyle: 'long', timeZone: 'UTC' })
                .format(new Date(`${selectedCalendarDate}T00:00:00Z`))}</h2>
            </div>
            {selectionMode && <PhotoSelectionBar active count={activeSelectedAssetIds.length}
              onClear={clearPhotoSelection} onOpen={openSelectedAssets} />}
            {calendarAssetState === 'idle' || calendarAssetState === 'loading'
              ? <p className="gallery-message" role="status">{t('calendar.photosLoading')}</p>
              : calendarAssetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('calendar.photosLoadFailed')}</p>
                : calendarAssets.length === 0 ? <p className="gallery-message">{t('calendar.photosEmpty')}</p>
                  : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                    : renderPhotoGrid()}
          </> : <>
            <HomeCalendar year={calendarYear} month={calendarMonth} days={calendarDays}
              weekStart={resolveWeekStart(settings.weekStart, resolveDateLocale(settings.dateLocale))}
              loading={calendarState !== 'ready'} onYearChange={changeCalendarYear}
              onMonthChange={changeCalendarMonth} onDayOpen={openCalendarDay} />
            {calendarState === 'loading' && <p className="gallery-message" role="status">{t('calendar.loading')}</p>}
            {calendarState === 'error' && <p className="gallery-message error-text" role="alert">{t('calendar.loadFailed')}</p>}
          </>}
        </div>}
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
