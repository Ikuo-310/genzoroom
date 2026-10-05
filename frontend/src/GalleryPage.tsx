import { StackFilterControls } from './StackFilterControls';
import { readStackFilterMode, writeStackFilterMode, type StackFilterMode, type StackFilterTab } from './photoFilters';
import { aggregateStackEditStatuses, collapseImmichStacks, filterImmichStacks, filterImmichStacksByEditStatus, stackEditStatusIds } from './immichStacks';
import { SettingsButton } from './SettingsDialog';
import { resolveWorkspaceAssets } from './workspaceAssetResolver';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { homeScrollContent, homeViewKey, readHomeReturn, restoreHomeScroll, type CalendarViewMode, type HomeReturnContext, type HomeScrollPosition, type HomeTab } from './homeReturn';
import { fetchAlbumAssets, fetchAlbums, fetchCalendarDayAssets, fetchCalendarHeatmap, fetchCalendarMinYear, fetchFavoriteAssets, fetchRecentAssets } from './api';
import type { AlbumSummary } from './albums';
import { AlbumCard } from './AlbumCard';
import type { RecentAsset } from './assets';
import { type AppLanguage } from './i18n';
import { PhotoCard } from './PhotoCard';
import { useEditStatuses } from './useEditStatuses';
import { usePhotoSelection } from './usePhotoSelection';
import { HomeTitle } from './HomeTitle';
import { PhotoFilterControls } from './PhotoFilterControls';
import { EditStatusFilterControls } from './EditStatusFilterControls';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { useShortcutDisplay } from './useShortcutDisplay';
import { readWorkspaceSession } from './workspaceResume';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { HomeCalendar, HomeCalendarNavigation, type CalendarDay } from './HomeCalendar';
import { RECENT_PHOTO_COUNTS, resolveDateLocale, resolveWeekStart, updateSetting, useAppSettings, type RecentPhotoCount } from './appSettings';
import { filterPhotos, filterPhotosByEditStatus, photoFiltersForMode, readEditStatusFilterMode, readPhotoFilterMode, writeEditStatusFilterMode, writePhotoFilterMode, type EditStatusFilterMode, type PhotoFilterMode } from './photoFilters';
import {
  blurPhotoSelectionCheckboxWhenSelectionEnds,
  createWorkspaceNavigation,
  resolveSelectedAssets,
  shouldClearSelectionOnEscape,
  workspacePath,
} from './photoSelection';

type Connection = 'checking' | 'connected' | 'error';
type ImmichConnection = Connection | 'not-configured';
type AssetState = 'loading' | 'ready' | 'error';
type PhotoView = {
  kind: 'recent' | 'favorites' | 'album' | 'calendar';
  assets: RecentAsset[];
  state: 'idle' | AssetState;
  selection: ReturnType<typeof usePhotoSelection>;
};

export function GalleryPage() {
  const { t, i18n } = useTranslation();
  const shortcut = useShortcutDisplay();
  const settings = useAppSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [homeReturn] = useState(() => readHomeReturn(location.state?.homeReturn));
  const pageRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, HomeScrollPosition>());
  const pendingScroll = useRef<{ key: string; position: HomeScrollPosition; waitingForData: boolean } | null>(homeReturn
    ? { key: homeViewKey(homeReturn.tab, homeReturn.album?.id ?? null, homeReturn.year, homeReturn.month, homeReturn.date, homeReturn.calendarMode),
      position: homeReturn, waitingForData: true } : null);
  const [scrollRestoreRevision, setScrollRestoreRevision] = useState(0);
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const currentYear = new Date().getFullYear();
  const dateLocale = resolveDateLocale(settings.dateLocale);
  const [connection, setConnection] = useState<Connection>('checking');
  const [workspaceOpenError, setWorkspaceOpenError] = useState<'unsupported' | 'ambiguous' | null>(null);
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [favoriteAssets, setFavoriteAssets] = useState<RecentAsset[]>([]);
  const [favoriteState, setFavoriteState] = useState<'idle' | AssetState>('idle');
  const [activeTab, setActiveTab] = useState<HomeTab>(homeReturn?.tab ?? 'recent');
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [albumState, setAlbumState] = useState<'idle' | AssetState>('idle');
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumSummary | null>(homeReturn?.album ?? null);
  const [albumAssets, setAlbumAssets] = useState<RecentAsset[]>([]);
  const [albumAssetState, setAlbumAssetState] = useState<'idle' | AssetState>('idle');
  const [calendarYear, setCalendarYear] = useState(() => homeReturn?.year ?? new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => homeReturn?.month ?? new Date().getMonth() + 1);
  const [calendarMode, setCalendarMode] = useState<CalendarViewMode>(homeReturn?.calendarMode ?? 'month');
  const [calendarMinYear, setCalendarMinYear] = useState(currentYear);
  const [calendarMinYearReady, setCalendarMinYearReady] = useState(false);
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([]);
  const [calendarState, setCalendarState] = useState<'idle' | AssetState>('idle');
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(homeReturn?.date ?? null);
  const [calendarAssets, setCalendarAssets] = useState<RecentAsset[]>([]);
  const [calendarAssetState, setCalendarAssetState] = useState<'idle' | AssetState>('idle');
  const [stackFilterModes, setStackFilterModes] = useState<Record<StackFilterTab, StackFilterMode>>(() => ({
    recent: readStackFilterMode('recent'), albums: readStackFilterMode('albums'), calendar: readStackFilterMode('calendar'),
  }));
  const [photoFilterModes, setPhotoFilterModes] = useState<Record<HomeTab, PhotoFilterMode>>(() => ({
    recent: readPhotoFilterMode('recent'),
    albums: readPhotoFilterMode('albums'),
    calendar: readPhotoFilterMode('calendar'),
    favorites: readPhotoFilterMode('favorites'),
  }));
  const [editStatusFilterModes, setEditStatusFilterModes] = useState<Record<HomeTab, EditStatusFilterMode>>(() => ({
    recent: readEditStatusFilterMode('recent'),
    albums: readEditStatusFilterMode('albums'),
    calendar: readEditStatusFilterMode('calendar'),
    favorites: readEditStatusFilterMode('favorites'),
  }));
  // Keep every selection mounted while other tabs or parent views are displayed.
  const recentSelection = usePhotoSelection();
  const albumSelection = usePhotoSelection();
  const calendarSelection = usePhotoSelection();
  const favoriteSelection = usePhotoSelection();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const openStacksRef = useRef<() => void>(() => {});
  const openHomeWorkspaceRef = useRef<() => boolean>(() => false);
  const homeTabClickRef = useRef<(tab: HomeTab) => void>(() => {});
  const selectAllVisibleRef = useRef<() => boolean>(() => false);
  const captureHomeReturnRef = useRef<() => HomeReturnContext>(() => ({
    tab: 'recent', album: null, year: new Date().getFullYear(), month: new Date().getMonth() + 1,
    date: null, calendarMode: 'month', pageScrollTop: 0, contentScrollTop: 0,
  }));
  const selectedAssetsCountRef = useRef(0);
  const connectionRequestId = useRef(0);
  const albumAssetRequestId = useRef(0);
  const calendarHeatmapRequestId = useRef(0);
  const calendarAssetRequestId = useRef(0);
  const hasLoadedRecentAssets = useRef(false);
  const hasLoadedAlbums = useRef(false);
  const hasLoadedFavorites = useRef(false);
  const recentTab = useRef<HTMLButtonElement>(null);
  const albumsTab = useRef<HTMLButtonElement>(null);
  const calendarTab = useRef<HTMLButtonElement>(null);
  const favoritesTab = useRef<HTMLButtonElement>(null);
  const showingAlbumPhotos = activeTab === 'albums' && selectedAlbum !== null;
  const showingCalendarPhotos = activeTab === 'calendar' && selectedCalendarDate !== null;
  const photoView: PhotoView | null = activeTab === 'recent'
    ? { kind: 'recent', assets, state: assetState, selection: recentSelection }
    : activeTab === 'favorites'
      ? { kind: 'favorites', assets: favoriteAssets, state: favoriteState, selection: favoriteSelection }
      : showingAlbumPhotos
        ? { kind: 'album', assets: albumAssets, state: albumAssetState, selection: albumSelection }
        : showingCalendarPhotos
          ? { kind: 'calendar', assets: calendarAssets, state: calendarAssetState, selection: calendarSelection }
          : null;
  const editStatusAssets = photoView?.state === 'ready' ? photoView.assets : [];
  const editStatuses = useEditStatuses(stackEditStatusIds(editStatusAssets));
  const photoFilters = photoFiltersForMode(photoFilterModes[activeTab]);
  const viewKey = homeViewKey(activeTab, selectedAlbum?.id ?? null, calendarYear, calendarMonth, selectedCalendarDate, calendarMode);

  useEffect(() => { setWorkspaceOpenError(null); }, [viewKey]);

  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!pending || !pageRef.current) return;
    // Never apply an old offset if the user changes views before the restored request completes.
    if (pending.key !== viewKey) {
      pendingScroll.current = null;
      return;
    }
    const status = photoView?.state ?? (activeTab === 'albums' ? albumState : calendarState);
    if (pending.waitingForData || status === 'idle' || status === 'loading') return;
    // Card dimensions are established by CSS, so restoration can run after the data's DOM commit.
    restoreHomeScroll(pageRef.current, pending.position);
    scrollPositions.current.set(viewKey, readScrollPosition());
    pendingScroll.current = null;
  }, [activeTab, selectedAlbum, selectedCalendarDate, calendarYear, calendarMonth,
    assetState, favoriteState, albumState, albumAssetState, calendarState, calendarAssetState, viewKey, scrollRestoreRevision]);

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
        completeScrollRequest('recent');
        hasLoadedRecentAssets.current = true;
        setAssets(data);
        const availableIds = new Set(data.map(asset => asset.id));
        recentSelection.retainAvailable(availableIds);
        setAssetState('ready');
      }
    }).catch(() => {
      if (active && !hasLoadedRecentAssets.current) {
        completeScrollRequest('recent');
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
      completeScrollRequest('albums:list');
      setAlbums(data);
      setAlbumState('ready');
    }).catch(() => {
      if (active && !hasLoadedAlbums.current) {
        completeScrollRequest('albums:list');
        setAlbumState('error');
      }
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'favorites' || hasLoadedFavorites.current) return;
    const controller = new AbortController();
    let active = true;
    setFavoriteState('loading');
    void fetchFavoriteAssets(controller.signal).then(data => {
      if (!active) return;
      hasLoadedFavorites.current = true;
      completeScrollRequest('favorites');
      setFavoriteAssets(data);
      setFavoriteState('ready');
    }).catch(() => {
      if (!active) return;
      completeScrollRequest('favorites');
      setFavoriteState('error');
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'albums' || selectedAlbum === null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = albumAssetRequestId.current;
    void fetchAlbumAssets(selectedAlbum.id, controller.signal).then(data => {
      if (!active || requestId !== albumAssetRequestId.current) return;
      completeScrollRequest(`albums:${selectedAlbum.id}`);
      const availableIds = new Set(data.map(asset => asset.id));
      setAlbumAssets(data);
      albumSelection.retainAvailable(availableIds);
      setAlbumAssetState('ready');
    }).catch(() => {
      if (active && requestId === albumAssetRequestId.current) {
        completeScrollRequest(`albums:${selectedAlbum.id}`);
        setAlbumAssetState('error');
      }
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, selectedAlbum?.id]);

  useEffect(() => {
    if (activeTab !== 'calendar' || calendarMinYearReady) return;
    const controller = new AbortController();
    let active = true;
    void fetchCalendarMinYear(controller.signal).then(minYear => {
      if (!active) return;
      const validMinYear = minYear !== null && minYear >= 1 && minYear <= currentYear ? minYear : currentYear;
      setCalendarMinYear(validMinYear);
      setCalendarYear(year => Math.max(validMinYear, Math.min(currentYear, year)));
      setCalendarMinYearReady(true);
    }).catch(() => {
      if (!active) return;
      setCalendarMinYear(currentYear);
      setCalendarYear(year => Math.min(currentYear, year));
      setCalendarMinYearReady(true);
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, calendarMinYearReady, currentYear]);

  useEffect(() => {
    if (!calendarMinYearReady) return;
    if (activeTab !== 'calendar' || selectedCalendarDate !== null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = ++calendarHeatmapRequestId.current;
    setCalendarState('loading');
    void fetchCalendarHeatmap(calendarYear, calendarMode === 'year' ? null : calendarMonth, controller.signal).then(data => {
      if (!active || requestId !== calendarHeatmapRequestId.current) return;
      completeScrollRequest(homeViewKey('calendar', null, calendarYear, calendarMonth, null, calendarMode));
      setCalendarDays(data.days);
      setCalendarState('ready');
    }).catch(() => {
      if (active && requestId === calendarHeatmapRequestId.current) {
        completeScrollRequest(homeViewKey('calendar', null, calendarYear, calendarMonth, null, calendarMode));
        setCalendarState('error');
      }
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, calendarYear, calendarMonth, calendarMode, selectedCalendarDate, calendarMinYearReady]);

  useEffect(() => {
    if (activeTab !== 'calendar' || selectedCalendarDate === null) return;
    const controller = new AbortController();
    let active = true;
    const requestId = calendarAssetRequestId.current;
    void fetchCalendarDayAssets(selectedCalendarDate, controller.signal).then(data => {
      if (!active || requestId !== calendarAssetRequestId.current) return;
      completeScrollRequest(`calendar:${selectedCalendarDate}`);
      setCalendarAssets(data);
      const availableIds = new Set(data.map(asset => asset.id));
      calendarSelection.retainAvailable(availableIds);
      setCalendarAssetState('ready');
    }).catch(() => {
      if (active && requestId === calendarAssetRequestId.current) {
        completeScrollRequest(`calendar:${selectedCalendarDate}`);
        setCalendarAssetState('error');
      }
    });
    return () => { active = false; controller.abort(); };
  }, [activeTab, selectedCalendarDate]);

  // The active view owns its selection; shared asset IDs never carry selection across views.
  const currentAssets = photoView?.assets ?? [];
  const activeSelectedAssetIds = photoView?.selection.selectedIds ?? [];
  const stackAssets = activeTab === 'favorites' ? currentAssets : filterImmichStacks(currentAssets, stackFilterModes[activeTab]);
  const editFilteredAssets = activeTab === 'favorites'
    ? filterPhotosByEditStatus(stackAssets, editStatusFilterModes[activeTab], aggregateStackEditStatuses(stackAssets, editStatuses))
    : filterImmichStacksByEditStatus(stackAssets, editStatusFilterModes[activeTab], editStatuses);
  const typedAssets = filterPhotos(editFilteredAssets, photoFilters);
  const visibleAssets = activeTab !== 'favorites' && photoFilterModes[activeTab] === 'both'
    ? collapseImmichStacks(typedAssets) : typedAssets;
  const selectedAssets = resolveSelectedAssets(currentAssets, activeSelectedAssetIds);
  const selectionMode = photoView !== null && (photoView.kind === 'recent' || photoView.state === 'ready')
    && activeSelectedAssetIds.length > 0;
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
    function handleKeyDown(event: KeyboardEvent) {
      if (shouldClearSelectionOnEscape(event, selectionMode)) {
        if (selectionMode) photoView?.selection.clear();
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      if (matchesShortcut(event, 'homeOpenStackManager')) {
        if (selectionMode && selectedAssetsCountRef.current > 0) {
          event.preventDefault();
          openStacksRef.current();
        }
        return;
      }
      if (matchesShortcut(event, 'homeSelectAll')) {
        // Checkboxes and sliders allow S/D, but Primary+A must remain native for all inputs.
        if (event.target instanceof Element && event.target.closest('input')) return;
        if (selectAllVisibleRef.current()) event.preventDefault();
        return;
      }
      for (const [id, tab] of [['homeRecent', 'recent'], ['homeAlbums', 'albums'],
        ['homeCalendar', 'calendar'], ['homeFavorites', 'favorites']] as const) {
        if (matchesShortcut(event, id)) {
          event.preventDefault();
          homeTabClickRef.current(tab);
          return;
        }
      }
      if (!matchesShortcut(event, 'homeOpenSelected')) return;
      if (openHomeWorkspaceRef.current()) event.preventDefault();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectionMode, photoView?.selection.clear, navigate]);

  function selectAllVisible(): boolean {
    if (!photoView || photoView.state !== 'ready' || visibleAssets.length === 0) return false;
    photoView.selection.selectVisible(visibleAssets.map(asset => asset.id));
    return true;
  }
  // Keyboard listeners must use the current view and filters without resetting their lifetime.
  selectAllVisibleRef.current = selectAllVisible;
  homeTabClickRef.current = handleTabClick;

  function openWorkspace(asset: RecentAsset) {
    openWorkspaceAssets([asset]);
  }

  function openStacks() {
    if (!selectedAssets.length) return;
    // Stack management preserves concrete selections, including RAW and favorite members.
    navigate('/stack', { state: { selectedAssets, homeReturn: captureHomeReturn() } });
  }
  openStacksRef.current = openStacks;

  function openSelectedAssets() {
    openWorkspaceAssets(selectedAssets);
  }

  function openHomeWorkspace(): boolean {
    if (activeSelectedAssetIds.length > 0) {
      if (!selectedAssets.length) return false;
      openSelectedAssets();
      return true;
    }
    const resume = readWorkspaceSession();
    if (!resume) return false;
    navigate(workspacePath(resume.activeAssetId), {
      state: { ...resume, homeReturn: captureHomeReturnRef.current() },
    });
    return true;
  }

  function openWorkspaceAssets(assetsToOpen: RecentAsset[]) {
    const resolution = activeTab === 'favorites'
      ? { status: 'resolved' as const, assets: assetsToOpen }
      : resolveWorkspaceAssets(assetsToOpen, currentAssets);
    if (resolution.status !== 'resolved') {
      setWorkspaceOpenError(resolution.status);
      return;
    }
    setWorkspaceOpenError(null);
    const state = createWorkspaceNavigation(resolution.assets);
    if (state) navigate(workspacePath(state.activeAssetId), { state: { ...state, homeReturn: captureHomeReturn() } });
  }
  selectedAssetsCountRef.current = selectedAssets.length;
  openHomeWorkspaceRef.current = openHomeWorkspace;

  function readScrollPosition(): HomeScrollPosition {
    const page = pageRef.current;
    return { pageScrollTop: page?.scrollTop ?? 0,
      contentScrollTop: page ? homeScrollContent(page)?.scrollTop ?? 0 : 0 };
  }

  function captureHomeReturn(): HomeReturnContext {
    // Route exits must preserve the intended offset while the current view is still restoring.
    const pending = pendingScroll.current;
    const position = pending?.key === viewKey ? pending.position : readScrollPosition();
    return { tab: activeTab, album: selectedAlbum, year: calendarYear, month: calendarMonth,
      date: selectedCalendarDate, calendarMode, ...position };
  }
  captureHomeReturnRef.current = captureHomeReturn;

  function prepareScrollTransition(nextKey: string) {
    if (nextKey === viewKey) return;
    // A view left before restoration completes must retain its intended offset, not the loading DOM's offset.
    scrollPositions.current.set(viewKey, pendingScroll.current?.key === viewKey
      ? pendingScroll.current.position : readScrollPosition());
    pendingScroll.current = { key: nextKey,
      position: scrollPositions.current.get(nextKey) ?? { pageScrollTop: 0, contentScrollTop: 0 },
      waitingForData: nextKey === 'recent' ? !hasLoadedRecentAssets.current
        : nextKey === 'favorites' ? !hasLoadedFavorites.current
        : nextKey === 'albums:list' ? !hasLoadedAlbums.current : true };
  }

  function completeScrollRequest(key: string) {
    const pending = pendingScroll.current;
    if (!pending || pending.key !== key || !pending.waitingForData) return;
    pending.waitingForData = false;
    // A ref alone cannot trigger restoration when a refetch returns the same asset array.
    setScrollRestoreRevision(revision => revision + 1);
  }

  function togglePhotoSelection(assetId: string, extendRange = false) {
    photoView?.selection.toggle(assetId, visibleAssets.map(asset => asset.id), extendRange);
  }

  function clearPhotoSelection() {
    photoView?.selection.clear();
  }

  function openAlbum(album: AlbumSummary) {
    prepareScrollTransition(`albums:${album.id}`);
    // Invalidate the previous request before React runs its effect cleanup.
    albumAssetRequestId.current += 1;
    albumSelection.clear();
    setAlbumAssets([]);
    setAlbumAssetState('loading');
    setSelectedAlbum(album);
  }

  function closeAlbum() {
    prepareScrollTransition('albums:list');
    albumAssetRequestId.current += 1;
    albumSelection.clear();
    setAlbumAssets([]);
    setAlbumAssetState('idle');
    setSelectedAlbum(null);
  }

  function changeCalendarPeriod(year: number, month: number, mode: CalendarViewMode = calendarMode) {
    if (year < calendarMinYear || year > currentYear || month < 1 || month > 12) return;
    if (year === calendarYear && month === calendarMonth && mode === calendarMode) return;
    // Year-crossing arrows must queue one final view key, not an intermediate year/month combination.
    prepareScrollTransition(homeViewKey('calendar', null, year, month, null, mode));
    calendarHeatmapRequestId.current += 1;
    setCalendarYear(year);
    setCalendarMonth(month);
    setCalendarMode(mode);
  }

  function changeCalendarYear(year: number) {
    changeCalendarPeriod(year, calendarMonth);
  }

  function changeCalendarMonth(month: number) {
    changeCalendarPeriod(calendarYear, month, 'month');
  }

  function openCalendarMonth(month: number) {
    changeCalendarPeriod(calendarYear, month, 'month');
  }

  function changeCalendarMode(mode: CalendarViewMode) {
    changeCalendarPeriod(calendarYear, calendarMonth, mode);
  }

  function goToCurrentCalendarYear() {
    changeCalendarYear(new Date().getFullYear());
  }

  function goToCurrentCalendarMonth() {
    const today = new Date();
    changeCalendarPeriod(today.getFullYear(), today.getMonth() + 1, 'month');
  }

  function openCalendarDay(day: string) {
    prepareScrollTransition(`calendar:${day}`);
    calendarAssetRequestId.current += 1;
    calendarSelection.clear();
    setCalendarAssets([]);
    setCalendarAssetState('loading');
    // The parent mode stays intact, while the date's month becomes the Month view destination.
    setCalendarYear(Number(day.slice(0, 4)));
    setCalendarMonth(Number(day.slice(5, 7)));
    setSelectedCalendarDate(day);
  }

  function closeCalendarDay() {
    prepareScrollTransition(homeViewKey('calendar', null, calendarYear, calendarMonth, null, calendarMode));
    calendarAssetRequestId.current += 1;
    calendarSelection.clear();
    setCalendarAssets([]);
    setCalendarAssetState('idle');
    setSelectedCalendarDate(null);
  }

  function handleTabClick(tab: HomeTab) {
    if (tab !== activeTab) {
      prepareScrollTransition(homeViewKey(tab, selectedAlbum?.id ?? null, calendarYear, calendarMonth, selectedCalendarDate, calendarMode));
      setActiveTab(tab);
      return;
    }
    // Reactivating a tab uses the same parent-view transition as its back button.
    // Switching tabs must leave the inactive tab's detail and selection intact.
    if (tab === 'albums' && selectedAlbum !== null) closeAlbum();
    else if (tab === 'calendar' && selectedCalendarDate !== null) closeCalendarDay();
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs: HomeTab[] = ['recent', 'albums', 'calendar', 'favorites'];
    const index = tabs.indexOf(activeTab);
    const next: HomeTab = event.key === 'Home' ? 'recent' : event.key === 'End' ? 'favorites'
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (next !== activeTab) {
      prepareScrollTransition(homeViewKey(next, selectedAlbum?.id ?? null, calendarYear, calendarMonth, selectedCalendarDate, calendarMode));
      setActiveTab(next);
    }
    (next === 'recent' ? recentTab : next === 'albums' ? albumsTab : next === 'calendar' ? calendarTab : favoritesTab).current?.focus();
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
      <header className="app-header">
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
        <SettingsButton />
      </header>
      <div className="home-tabs-bar">
        <div className="home-tabs" role="tablist" aria-label={t('home.sections')}>
          <button id="home-recent-tab" ref={recentTab} type="button" role="tab" aria-controls="home-recent-panel"
            aria-selected={activeTab === 'recent'} tabIndex={activeTab === 'recent' ? 0 : -1}
            onClick={() => handleTabClick('recent')} onKeyDown={handleTabKeyDown}>{shortcut.inline(t('home.recentTab'), 'homeRecent')}</button>
          <button id="home-albums-tab" ref={albumsTab} type="button" role="tab" aria-controls="home-albums-panel"
            aria-selected={activeTab === 'albums'} tabIndex={activeTab === 'albums' ? 0 : -1}
            onClick={() => handleTabClick('albums')} onKeyDown={handleTabKeyDown}>{shortcut.inline(t('home.albumsTab'), 'homeAlbums')}</button>
          <button id="home-calendar-tab" ref={calendarTab} type="button" role="tab" aria-controls="home-calendar-panel"
            aria-selected={activeTab === 'calendar'} tabIndex={activeTab === 'calendar' ? 0 : -1}
            onClick={() => handleTabClick('calendar')} onKeyDown={handleTabKeyDown}>{shortcut.inline(t('home.calendarTab'), 'homeCalendar')}</button>
          <button id="home-favorites-tab" ref={favoritesTab} type="button" role="tab" aria-controls="home-favorites-panel"
            aria-selected={activeTab === 'favorites'} tabIndex={activeTab === 'favorites' ? 0 : -1}
            onClick={() => handleTabClick('favorites')} onKeyDown={handleTabKeyDown}>{shortcut.inline(t('home.favoritesTab'), 'homeFavorites')}</button>
        </div>
      </div>
      <div className={`home-toolbar${activeTab === 'calendar' && !selectedCalendarDate ? ' home-toolbar-calendar' : ''}${(activeTab === 'albums' && selectedAlbum) || (activeTab === 'calendar' && selectedCalendarDate) ? ' home-toolbar-centered' : ''}`}>
        {photoView && <div className="home-toolbar-left">
          <PhotoSelectionBar count={activeSelectedAssetIds.length}
          canSelectAll={photoView?.state === 'ready' && visibleAssets.some(asset => !activeSelectedAssetIds.includes(asset.id))}
          onSelectAll={selectAllVisible}
          onClear={clearPhotoSelection} onOpen={openHomeWorkspace} onOpenStacks={openStacks} />
          {activeTab === 'albums' && selectedAlbum && <div className="home-toolbar-context">
              <button type="button" className="album-back" aria-label={t('albums.backToList')} title={t('albums.backToList')} onClick={closeAlbum}>←</button>
            </div>}
          {activeTab === 'calendar' && selectedCalendarDate && <div className="home-toolbar-context">
              <button type="button" className="album-back" aria-label={t(calendarMode === 'year' ? 'calendar.backToYear' : 'calendar.backToMonth')}
                title={t(calendarMode === 'year' ? 'calendar.backToYear' : 'calendar.backToMonth')} onClick={closeCalendarDay}>←</button>
            </div>}
        </div>}
        {(activeTab === 'albums' && selectedAlbum || activeTab === 'calendar' && selectedCalendarDate) && <div className="home-toolbar-center">
          {selectedAlbum && activeTab === 'albums' && <h2 className="home-toolbar-title" title={selectedAlbum.albumName}>{selectedAlbum.albumName}</h2>}
          {selectedCalendarDate && activeTab === 'calendar' && <h2 className="home-toolbar-title">{new Intl.DateTimeFormat(dateLocale, { dateStyle: 'long', timeZone: 'UTC' })
            .format(new Date(`${selectedCalendarDate}T00:00:00Z`))}</h2>}
        </div>}
        {activeTab === 'calendar' && !selectedCalendarDate && <div className="home-toolbar-center">
          <HomeCalendarNavigation year={calendarYear} month={calendarMonth} mode={calendarMode}
            minYear={calendarMinYear} maxYear={currentYear} dateLocale={dateLocale}
            onYearChange={changeCalendarYear} onMonthChange={changeCalendarMonth}
            onCurrentMonth={goToCurrentCalendarMonth} onCurrentYear={goToCurrentCalendarYear}
            onNavigate={changeCalendarPeriod} onModeChange={changeCalendarMode} />
        </div>}
        <div className="home-toolbar-controls">
          {photoView && activeTab !== 'favorites' && <StackFilterControls mode={stackFilterModes[activeTab]} onChange={mode => {
            setStackFilterModes(current => ({ ...current, [activeTab]: mode }));
            writeStackFilterMode(mode, activeTab);
          }} />}
          {photoView && <EditStatusFilterControls mode={editStatusFilterModes[activeTab]} onChange={mode => {
            setEditStatusFilterModes(current => ({ ...current, [activeTab]: mode }));
            writeEditStatusFilterMode(mode, activeTab);
          }} />}
          {photoView && <PhotoFilterControls filters={photoFilters} onChange={mode => {
            setPhotoFilterModes(current => ({ ...current, [activeTab]: mode }));
            writePhotoFilterMode(mode, activeTab);
          }} />}
          {activeTab === 'recent' && <>
            <label className="home-control recent-count-control"><span className="home-control-label">{t('photos.recentCount')}</span>
              <select value={settings.recentPhotoCount}
                onChange={event => updateSetting('recentPhotoCount', Number(event.target.value) as RecentPhotoCount)}>
                {RECENT_PHOTO_COUNTS.map(count => <option key={count} value={count}>{t('photos.recentCountOption', { count })}</option>)}
              </select>
            </label>
          </>}
          {(photoView || activeTab === 'albums') && <div className="home-control thumbnail-size-setting">
            <span className="home-control-label">{t('photos.thumbnailSize')}</span>
            <HomeThumbnailSizeControl />
          </div>}
        </div>
      </div>
      <section className="home-content" aria-label={t('home.sections')}>
        {workspaceOpenError && <p className="gallery-message error-text" role="alert">{t(workspaceOpenError === 'unsupported' ? 'photos.workspaceUnsupported' : 'photos.workspaceAmbiguous')}</p>}
        {activeTab === 'recent' ? <div id="home-recent-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-recent-tab">
        {assetState === 'loading' ? <p className="gallery-message" role="status">{t('photos.loading')}</p>
          : assetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('photos.loadFailed')}</p>
            : assets.length === 0 ? <p className="gallery-message">{t('photos.empty')}</p>
              : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                : renderPhotoGrid()}
        </div> : activeTab === 'favorites' ? <div id="home-favorites-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-favorites-tab">
          {favoriteState === 'idle' || favoriteState === 'loading'
            ? <p className="gallery-message" role="status">{t('favorites.loading')}</p>
            : favoriteState === 'error' ? <p className="gallery-message error-text" role="alert">{t('favorites.loadFailed')}</p>
              : favoriteAssets.length === 0 ? <p className="gallery-message">{t('favorites.empty')}</p>
                : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                  : renderPhotoGrid()}
        </div> : activeTab === 'albums' ? <div id="home-albums-panel" className="home-tab-panel" role="tabpanel" aria-labelledby="home-albums-tab">
          {selectedAlbum ? <>
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
            {calendarAssetState === 'idle' || calendarAssetState === 'loading'
              ? <p className="gallery-message" role="status">{t('calendar.photosLoading')}</p>
              : calendarAssetState === 'error' ? <p className="gallery-message error-text" role="alert">{t('calendar.photosLoadFailed')}</p>
                : calendarAssets.length === 0 ? <p className="gallery-message">{t('calendar.photosEmpty')}</p>
                  : visibleAssets.length === 0 ? <p className="gallery-message">{t('photos.noMatches')}</p>
                    : renderPhotoGrid()}
          </> : <>
            <HomeCalendar year={calendarYear} month={calendarMonth} mode={calendarMode} days={calendarDays}
              weekStart={resolveWeekStart(settings.weekStart, dateLocale)} loading={calendarState !== 'ready'}
              onMonthOpen={openCalendarMonth} onDayOpen={openCalendarDay} />
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
