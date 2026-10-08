import { aggregateStackEditStatuses, collapseImmichStacks, filterImmichStacks, filterImmichStacksByEditStatus, stackEditStatusIds } from './immichStacks';
import { SettingsButton } from './SettingsDialog';
import { resolveWorkspaceAssets } from './workspaceAssetResolver';
import { frontendLogger } from './frontendLogging';
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
import { useExportQueue } from './useExportQueue';
import { useExportManagement } from './useExportManagement';
import { ExportQueueApiError } from './exportQueueApi';
import { usePhotoSelection } from './usePhotoSelection';
import { useAdjacentCalendarDates } from './useAdjacentCalendarDates';
import { HomeTitle } from './HomeTitle';
import { EditStatusFilterControls } from './EditStatusFilterControls';
import { DevelopStatusFilterControls } from './DevelopStatusFilterControls';
import { HomeToolbarSelect } from './HomeToolbarSelect';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { useShortcutDisplay } from './useShortcutDisplay';
import { readWorkspaceSession } from './workspaceResume';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { ExportManagementContent, ExportManagementToolbar, ExportRetryPriorityNotice } from './ExportManagement';
import { adjacentCalendarPeriod, HomeCalendar, HomeCalendarNavigation, type CalendarDay } from './HomeCalendar';
import { RECENT_PHOTO_COUNTS, resolveDateLocale, resolveWeekStart, updateSetting, useAppSettings, type RecentPhotoCount } from './appSettings';
import { filterPhotos, filterPhotosByDevelopStatus, filterPhotosByEditStatus, photoFiltersForMode, readDevelopStatusFilterMode, readEditStatusFilterMode, writeDevelopStatusFilterMode, writeEditStatusFilterMode, type DevelopStatusFilterMode, type EditStatusFilterMode } from './photoFilters';
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
type HomeNavigationTab = HomeTab | 'export';
type PhotoView = {
  kind: 'recent' | 'favorites' | 'album' | 'calendar';
  assets: RecentAsset[];
  state: 'idle' | AssetState;
  selection: ReturnType<typeof usePhotoSelection>;
};

export function GalleryPage() {
  const { t, i18n } = useTranslation();
  const recentCountSelectId = useId();
  const shortcut = useShortcutDisplay();
  const settings = useAppSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const exportQueue = useExportQueue();
  const [queueFailure, setQueueFailure] = useState<'addFailed' | 'removeFailed' | 'notEligible' | 'locked' | null>(null);
  const queueOperations = useRef(new Set<string>());
  const [queueBusy, setQueueBusy] = useState<Set<string>>(() => new Set());
  const queueBatchBusy = useRef(false);
  const [queueBatchBusyState, setQueueBatchBusyState] = useState(false);
  const queueMounted = useRef(true);
  useEffect(() => {
    queueMounted.current = true;
    return () => { queueMounted.current = false; };
  }, []);
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
  const [workspaceOpenError, setWorkspaceOpenError] = useState<'unavailable' | 'empty' | null>(null);
  const workspaceNavigating = useRef(false);
  const [immichConnection, setImmichConnection] = useState<ImmichConnection>('checking');
  const [assets, setAssets] = useState<RecentAsset[]>([]);
  const [assetState, setAssetState] = useState<AssetState>('loading');
  const [favoriteAssets, setFavoriteAssets] = useState<RecentAsset[]>([]);
  const [favoriteState, setFavoriteState] = useState<'idle' | AssetState>('idle');
  const [activeTab, setActiveTab] = useState<HomeTab>(homeReturn?.tab ?? 'recent');
  // Management navigation preserves the browsing tab without entering photo filters or route state.
  const [showExport, setShowExport] = useState(false);
  const exportManagement = useExportManagement(exportQueue, showExport);
  const exportManagementRef = useRef({ active: showExport, state: exportManagement });
  exportManagementRef.current = { active: showExport, state: exportManagement };
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
  const [editStatusFilterModes, setEditStatusFilterModes] = useState<Record<HomeTab, EditStatusFilterMode>>(() => ({
    recent: readEditStatusFilterMode('recent'),
    albums: readEditStatusFilterMode('albums'),
    calendar: readEditStatusFilterMode('calendar'),
    favorites: readEditStatusFilterMode('favorites'),
  }));
  const [developStatusFilterModes, setDevelopStatusFilterModes] = useState<Record<HomeTab, DevelopStatusFilterMode>>(() => ({
    recent: readDevelopStatusFilterMode('recent'),
    albums: readDevelopStatusFilterMode('albums'),
    calendar: readDevelopStatusFilterMode('calendar'),
    favorites: readDevelopStatusFilterMode('favorites'),
  }));
  // Keep every selection mounted while other tabs or parent views are displayed.
  const recentSelection = usePhotoSelection();
  const albumSelection = usePhotoSelection();
  const calendarSelection = usePhotoSelection();
  const favoriteSelection = usePhotoSelection();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const openStacksRef = useRef<() => void>(() => {});
  const openHomeWorkspaceRef = useRef<() => boolean>(() => false);
  const queueSelectedRef = useRef<() => boolean>(() => false);
  const homeTabClickRef = useRef<(tab: HomeNavigationTab) => void>(() => {});
  const selectAllVisibleRef = useRef<() => boolean>(() => false);
  const navigateCalendarRef = useRef<(direction: 'previous' | 'next') => boolean>(() => false);
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
  const showingAlbumPhotos = !showExport && activeTab === 'albums' && selectedAlbum !== null;
  const showingCalendarPhotos = !showExport && activeTab === 'calendar' && selectedCalendarDate !== null;
  const adjacentCalendarDates = useAdjacentCalendarDates(
    showingCalendarPhotos && calendarMinYearReady ? selectedCalendarDate : null, calendarMinYear, currentYear);
  const photoView: PhotoView | null = showExport ? null : activeTab === 'recent'
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
  const photoFilters = photoFiltersForMode('both');
  const viewKey = showExport ? 'export' : homeViewKey(activeTab, selectedAlbum?.id ?? null, calendarYear, calendarMonth, selectedCalendarDate, calendarMode);

  useEffect(() => { setWorkspaceOpenError(null); }, [viewKey]);

  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!pending || !pageRef.current) return;
    // Never apply an old offset if the user changes views before the restored request completes.
    if (pending.key !== viewKey) {
      pendingScroll.current = null;
      return;
    }
    const status = showExport ? 'ready' : photoView?.state ?? (activeTab === 'albums' ? albumState : calendarState);
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
  const cardEditStatuses = aggregateStackEditStatuses(currentAssets, editStatuses);
  const activeSelectedAssetIds = photoView?.selection.selectedIds ?? [];
  const stackAssets = activeTab === 'favorites' ? currentAssets : filterImmichStacks(currentAssets, 'both');
  const editFilteredAssets = activeTab === 'favorites'
    ? filterPhotosByEditStatus(stackAssets, editStatusFilterModes[activeTab], aggregateStackEditStatuses(stackAssets, editStatuses))
    : filterImmichStacksByEditStatus(stackAssets, editStatusFilterModes[activeTab], editStatuses);
  const typedAssets = filterPhotos(editFilteredAssets, photoFilters);
  const collapsedAssets = activeTab !== 'favorites' ? collapseImmichStacks(typedAssets) : typedAssets;
  const visibleAssets = filterPhotosByDevelopStatus(collapsedAssets, developStatusFilterModes[activeTab]);
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
      const exportView = exportManagementRef.current;
      if (exportView.active && !event.isComposing && !event.repeat
        && !document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')
        && shouldClearSelectionOnEscape(event, exportView.state.selectedIds.length > 0)) {
        exportView.state.clear();
        return;
      }
      if (shouldClearSelectionOnEscape(event, selectionMode)) {
        if (selectionMode) photoView?.selection.clear();
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      if (exportView.active) {
        // Export commands share Home guards, but own separate selection and session-only armed state.
        if (matchesShortcut(event, 'undo')) {
          // Keep native undo behavior for every form control, including non-text inputs.
          if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
          if (exportView.state.undo()) event.preventDefault();
          return;
        }
        if (matchesShortcut(event, 'homeSelectAll') || matchesShortcut(event, 'exportArmToggle') || matchesShortcut(event, 'exportQueueToggle')) {
          if (event.target instanceof Element && event.target.closest('input')) return;
          const handled = matchesShortcut(event, 'homeSelectAll') ? exportView.state.selectAll()
            : matchesShortcut(event, 'exportArmToggle') ? exportView.state.toggleArmed() : exportView.state.removeSelected();
          if (handled) event.preventDefault();
          return;
        }
      }
      for (const [id, direction] of [['calendarNavigatePrevious', 'previous'], ['calendarNavigateNext', 'next']] as const) {
        if (matchesShortcut(event, id)) {
          // Sliders and checkboxes retain their native arrow behavior, unlike S/D commands.
          if (event.target instanceof Element && event.target.closest('input')) return;
          if (navigateCalendarRef.current(direction)) event.preventDefault();
          return;
        }
      }
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
      if (matchesShortcut(event, 'exportQueueToggle')) {
        if (event.target instanceof Element && event.target.closest('input')) return;
        if (selectionMode && selectedAssetsCountRef.current > 0 && queueSelectedRef.current()) event.preventDefault();
        return;
      }
      for (const [id, tab] of [['homeRecent', 'recent'], ['homeAlbums', 'albums'],
        ['homeCalendar', 'calendar'], ['homeFavorites', 'favorites'], ['homeExport', 'export']] as const) {
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
    if (showExport || workspaceNavigating.current) return false;
    if (activeSelectedAssetIds.length > 0) {
      if (!selectedAssets.length) return false;
      openSelectedAssets();
      return true;
    }
    const resume = readWorkspaceSession();
    if (!resume) return false;
    workspaceNavigating.current = true;
    setWorkspaceOpenError(null);
    navigate(workspacePath(resume.activeAssetId), {
      state: { ...resume, homeReturn: captureHomeReturnRef.current() },
    });
    return true;
  }

  function openWorkspaceAssets(assetsToOpen: RecentAsset[]) {
    if (workspaceNavigating.current) return;
    const resolution = resolveWorkspaceAssets(assetsToOpen, settings.anshitsuInitialSelection);
    try {
      frontendLogger.add({ level: resolution.status === 'unavailable' ? 'error' : resolution.status === 'empty' ? 'info' : 'debug',
        component: 'gallery', event: 'workspace.resolve', context: {
          result: resolution.status, selectedCardCount: assetsToOpen.length,
          stackCount: assetsToOpen.filter(asset => asset.stackId != null).length,
          targetAssetCount: resolution.status === 'resolved' ? resolution.assets.length : 0,
        } });
    } catch { /* Diagnostics must not change navigation outcomes. */ }
    if (resolution.status !== 'resolved') {
      setWorkspaceOpenError(resolution.status);
      return;
    }
    setWorkspaceOpenError(null);
    const state = createWorkspaceNavigation(resolution.assets);
    if (state) {
      // Guard synchronous button/shortcut re-entry until the successful route exit unmounts Gallery.
      workspaceNavigating.current = true;
      navigate(workspacePath(state.activeAssetId), { state: { ...state, homeReturn: captureHomeReturn() } });
    }
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

  function prepareScrollTransition(nextKey: string, waitingForData?: boolean) {
    if (nextKey === viewKey) return;
    // A view left before restoration completes must retain its intended offset, not the loading DOM's offset.
    scrollPositions.current.set(viewKey, pendingScroll.current?.key === viewKey
      ? pendingScroll.current.position : readScrollPosition());
    pendingScroll.current = { key: nextKey,
      position: scrollPositions.current.get(nextKey) ?? { pageScrollTop: 0, contentScrollTop: 0 },
      waitingForData: waitingForData ?? (nextKey === 'export' ? false : nextKey === 'recent' ? !hasLoadedRecentAssets.current
        : nextKey === 'favorites' ? !hasLoadedFavorites.current
        : nextKey === 'albums:list' ? !hasLoadedAlbums.current : true) };
  }

  function completeScrollRequest(key: string) {
    const pending = pendingScroll.current;
    if (!pending || pending.key !== key || !pending.waitingForData) return;
    pending.waitingForData = false;
    // A ref alone cannot trigger restoration when a refetch returns the same asset array.
    setScrollRestoreRevision(revision => revision + 1);
  }

  function selectPhoto(assetId: string) {
    photoView?.selection.selectOnly(assetId);
  }

  function togglePhotoSelection(assetId: string) {
    photoView?.selection.toggle(assetId);
  }

  function extendPhotoSelection(assetId: string) {
    photoView?.selection.extendRange(assetId, visibleAssets.map(asset => asset.id));
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

  function moveCalendarDay(direction: 'previous' | 'next'): boolean {
    const day = adjacentCalendarDates[direction];
    if (!showingCalendarPhotos || !day) return false;
    // Prevent another event from using the old date's candidate before the navigation commit.
    navigateCalendarRef.current = () => false;
    openCalendarDay(day);
    return true;
  }
  function navigateCalendar(direction: 'previous' | 'next'): boolean {
    if (showExport || activeTab !== 'calendar' || !calendarMinYearReady) return false;
    if (selectedCalendarDate !== null) return moveCalendarDay(direction);
    const target = adjacentCalendarPeriod(calendarYear, calendarMonth, calendarMode, direction === 'previous' ? -1 : 1);
    if (target.year < calendarMinYear || target.year > currentYear) return false;
    // Period navigation uses the same pre-commit input lock as date-detail navigation.
    navigateCalendarRef.current = () => false;
    changeCalendarPeriod(target.year, target.month);
    return true;
  }
  navigateCalendarRef.current = navigateCalendar;

  function closeCalendarDay() {
    prepareScrollTransition(homeViewKey('calendar', null, calendarYear, calendarMonth, null, calendarMode));
    calendarAssetRequestId.current += 1;
    calendarSelection.clear();
    setCalendarAssets([]);
    setCalendarAssetState('idle');
    setSelectedCalendarDate(null);
  }

  function handleTabClick(tab: HomeNavigationTab) {
    if (tab === 'export') {
      prepareScrollTransition('export');
      setShowExport(true);
      return;
    }
    if (showExport || tab !== activeTab) {
      // The retained browsing view does not refetch when returning from management to the same tab.
      prepareScrollTransition(homeViewKey(tab, selectedAlbum?.id ?? null, calendarYear, calendarMonth, selectedCalendarDate, calendarMode),
        showExport && tab === activeTab ? false : undefined);
      setShowExport(false);
      setActiveTab(tab);
      return;
    }
    // Reactivating a tab uses the same parent-view transition as its back button.
    // Switching tabs must leave the inactive tab's detail and selection intact.
    if (tab === 'albums' && selectedAlbum !== null) closeAlbum();
    else if (tab === 'calendar' && selectedCalendarDate !== null) closeCalendarDay();
  }

  function queueStateFor(asset: RecentAsset) {
    const memberIds = stackEditStatusIds([asset]);
    const status = (['encoding', 'registering', 'waiting', 'failed', 'queued'] as const)
      .find(status => memberIds.some(id => exportQueue.getStatus(id) === status));
    return { memberIds, status, busy: queueBatchBusyState || memberIds.some(id => queueBusy.has(id.toLowerCase()) || !!exportQueue.mutationFor(id).operation) };
  }

  function uniqueQueueMemberIds(memberIds: readonly string[]): string[] {
    const seen = new Set<string>();
    return memberIds.filter(id => {
      const key = id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function editedQueueMemberIds(memberIds: readonly string[]): string[] {
    return uniqueQueueMemberIds(memberIds).filter(id => editStatuses[id] === true);
  }

  async function enqueueQueueMembers(memberIds: readonly string[]): Promise<void> {
    const uniqueIds = uniqueQueueMemberIds(memberIds);
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      if (!queueMounted.current) return;
      await exportQueue.enqueue(uniqueIds.slice(offset, offset + 100));
    }
  }

  function queueSelectedAssets(): boolean {
    if (!selectionMode || selectedAssets.length === 0) return false;
    if (queueBatchBusy.current) return true;
    if (!exportQueue.loaded) return true;

    const eligible = selectedAssets.filter(asset => cardEditStatuses[asset.id] === true);
    if (eligible.length === 0) return false;
    const cards = eligible.map(asset => ({ asset, ...queueStateFor(asset) }));
    if (cards.some(card => card.status === 'waiting' || card.status === 'encoding' || card.status === 'registering')) {
      setQueueFailure('locked');
      return true;
    }
    const reservedKeys = [...new Set(cards.flatMap(card => card.memberIds.map(id => id.toLowerCase())))];
    if (reservedKeys.some(key => queueOperations.current.has(key))
      || cards.some(card => card.memberIds.some(id => !!exportQueue.mutationFor(id).operation))) return true;

    const enqueueing = cards.some(card => card.status === undefined);
    const directionCards = cards.filter(card => enqueueing ? card.status === undefined : card.status !== undefined);
    const directionMemberIds = directionCards.flatMap(card => card.memberIds);
    const targets = enqueueing ? editedQueueMemberIds(directionMemberIds)
      : uniqueQueueMemberIds(directionMemberIds).filter(id => exportQueue.hasAsset(id));
    if (targets.length === 0) return true;

    queueBatchBusy.current = true;
    setQueueBatchBusyState(true);
    reservedKeys.forEach(key => queueOperations.current.add(key));
    setQueueBusy(new Set(queueOperations.current));
    setQueueFailure(null);
    void (async () => {
      try {
        if (enqueueing) {
          // Keep full-snapshot responses ordered while respecting the API's per-request limit.
          await enqueueQueueMembers(targets);
        } else {
          for (const id of targets) {
            if (!queueMounted.current) return;
            await exportQueue.dequeue(id);
          }
        }
      } catch (cause) {
        if (queueMounted.current) {
          setQueueFailure(cause instanceof ExportQueueApiError && cause.kind === 'not_eligible' ? 'notEligible'
            : cause instanceof ExportQueueApiError && cause.kind === 'locked' ? 'locked'
              : enqueueing ? 'addFailed' : 'removeFailed');
          void exportQueue.refresh();
        }
      } finally {
        reservedKeys.forEach(key => queueOperations.current.delete(key));
        queueBatchBusy.current = false;
        if (queueMounted.current) {
          setQueueBusy(new Set(queueOperations.current));
          setQueueBatchBusyState(false);
        }
      }
    })();
    return true;
  }
  queueSelectedRef.current = queueSelectedAssets;

  async function toggleQueue(asset: RecentAsset) {
    if (queueBatchBusy.current || !exportQueue.loaded || cardEditStatuses[asset.id] !== true) return;
    const { memberIds, status } = queueStateFor(asset);
    const keys = memberIds.map(id => id.toLowerCase());
    if (memberIds.some((id, index) => queueOperations.current.has(keys[index]) || exportQueue.mutationFor(id).operation)) return;
    if (status === 'waiting' || status === 'encoding' || status === 'registering') {
      setQueueFailure('locked');
      return;
    }
    const removing = status !== undefined;
    const targets = removing ? uniqueQueueMemberIds(memberIds).filter(id => exportQueue.hasAsset(id))
      : editedQueueMemberIds(memberIds);
    if (targets.length === 0) return;
    // Reserve the whole card across sequential DELETEs, including overlapping member views.
    keys.forEach(key => queueOperations.current.add(key));
    setQueueBusy(new Set(queueOperations.current));
    setQueueFailure(null);
    try {
      if (removing) {
        for (const id of targets) {
          if (!queueMounted.current) return;
          // Successful removals remain committed if a later member fails.
          await exportQueue.dequeue(id);
        }
      } else {
        await enqueueQueueMembers(targets);
      }
    } catch (cause) {
      if (queueMounted.current) {
        setQueueFailure(cause instanceof ExportQueueApiError && cause.kind === 'not_eligible' ? 'notEligible'
          : cause instanceof ExportQueueApiError && cause.kind === 'locked' ? 'locked'
            : removing ? 'removeFailed' : 'addFailed');
        // Reconcile uncertain or externally changed membership without undoing successful mutations.
        void exportQueue.refresh();
      }
    } finally {
      keys.forEach(key => queueOperations.current.delete(key));
      if (queueMounted.current) setQueueBusy(new Set(queueOperations.current));
    }
  }

  function renderPhotoGrid() {
    return <div className="photo-grid" style={{ '--photo-column-width': `calc(${100 / settings.homeThumbnailColumns}% - ${16 * (settings.homeThumbnailColumns - 1) / settings.homeThumbnailColumns}px)` } as CSSProperties}>{visibleAssets.map((asset) => {
      const queue = queueStateFor(asset);
      return (
        <PhotoCard
          asset={asset}
          language={language}
          key={asset.id}
          selected={activeSelectedAssetIds.includes(asset.id)}
          selectionMode={selectionMode}
          edited={cardEditStatuses[asset.id]}
          queueKnown={exportQueue.loaded}
          queueStatus={queue.status}
          queueBusy={queue.busy}
          onQueueToggle={() => { void toggleQueue(asset); }}
          onSelect={() => selectPhoto(asset.id)}
          onToggleSelection={() => togglePhotoSelection(asset.id)}
          onExtendSelection={() => extendPhotoSelection(asset.id)}
        />
      );
    })}</div>;
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
          <div className="home-tabs-gallery">
            <button id="home-recent-tab" type="button" role="tab" aria-controls="home-recent-panel"
              aria-selected={!showExport && activeTab === 'recent'} onClick={() => handleTabClick('recent')}>{shortcut.inline(t('home.recentTab'), 'homeRecent')}</button>
            <button id="home-albums-tab" type="button" role="tab" aria-controls="home-albums-panel"
              aria-selected={!showExport && activeTab === 'albums'} onClick={() => handleTabClick('albums')}>{shortcut.inline(t('home.albumsTab'), 'homeAlbums')}</button>
            <button id="home-calendar-tab" type="button" role="tab" aria-controls="home-calendar-panel"
              aria-selected={!showExport && activeTab === 'calendar'} onClick={() => handleTabClick('calendar')}>{shortcut.inline(t('home.calendarTab'), 'homeCalendar')}</button>
            <button id="home-favorites-tab" type="button" role="tab" aria-controls="home-favorites-panel"
              aria-selected={!showExport && activeTab === 'favorites'} onClick={() => handleTabClick('favorites')}>{shortcut.inline(t('home.favoritesTab'), 'homeFavorites')}</button>
          </div>
          <div className="home-tabs-management">
            <button id="home-export-tab" type="button" role="tab" aria-controls="home-export-panel"
              aria-selected={showExport} onClick={() => handleTabClick('export')}>{shortcut.inline(t('home.exportTab'), 'homeExport')}</button>
          </div>
        </div>
        {showExport && <ExportRetryPriorityNotice management={exportManagement} />}
      </div>
      {showExport ? <ExportManagementToolbar management={exportManagement} /> : <div className={`home-toolbar${activeTab === 'calendar' && !selectedCalendarDate ? ' home-toolbar-calendar' : ''}${(activeTab === 'albums' && selectedAlbum) || (activeTab === 'calendar' && selectedCalendarDate) ? ' home-toolbar-centered' : ''}`}>
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
          {selectedCalendarDate && activeTab === 'calendar' && <div className="calendar-detail-navigation">
            <button type="button" className="calendar-detail-previous" disabled={!adjacentCalendarDates.previous}
              aria-label={t('calendar.previousPhotoDay')} title={t('calendar.previousPhotoDay')}
              onClick={() => navigateCalendarRef.current('previous')}>←</button>
            <h2 className="home-toolbar-title">{new Intl.DateTimeFormat(dateLocale, { dateStyle: 'long', timeZone: 'UTC' })
              .format(new Date(`${selectedCalendarDate}T00:00:00Z`))}</h2>
            <button type="button" className="calendar-detail-next" disabled={!adjacentCalendarDates.next}
              aria-label={t('calendar.nextPhotoDay')} title={t('calendar.nextPhotoDay')}
              onClick={() => navigateCalendarRef.current('next')}>→</button>
          </div>}
        </div>}
        {activeTab === 'calendar' && !selectedCalendarDate && <div className="home-toolbar-center">
          <HomeCalendarNavigation year={calendarYear} month={calendarMonth} mode={calendarMode}
            minYear={calendarMinYear} maxYear={currentYear} dateLocale={dateLocale}
            onYearChange={changeCalendarYear} onMonthChange={changeCalendarMonth}
            onCurrentMonth={goToCurrentCalendarMonth} onCurrentYear={goToCurrentCalendarYear}
            onNavigate={changeCalendarPeriod} onModeChange={changeCalendarMode} />
        </div>}
        <div className="home-toolbar-controls">
          {photoView && <EditStatusFilterControls mode={editStatusFilterModes[activeTab]} onChange={mode => {
            setEditStatusFilterModes(current => ({ ...current, [activeTab]: mode }));
            writeEditStatusFilterMode(mode, activeTab);
          }} />}
          {photoView && <DevelopStatusFilterControls mode={developStatusFilterModes[activeTab]} onChange={mode => {
            setDevelopStatusFilterModes(current => ({ ...current, [activeTab]: mode }));
            writeDevelopStatusFilterMode(mode, activeTab);
          }} />}
          {activeTab === 'recent' && <>
            <div className="home-control recent-count-control">
              <label className="home-control-label" htmlFor={recentCountSelectId}>{t('photos.recentCount')}</label>
              <HomeToolbarSelect id={recentCountSelectId} aria-label={t('photos.recentCount')}
                value={settings.recentPhotoCount}
                selectedLabel={t('photos.recentCountOption', { count: settings.recentPhotoCount })}
                onChange={event => updateSetting('recentPhotoCount', Number(event.target.value) as RecentPhotoCount)}>
                {RECENT_PHOTO_COUNTS.map(count => <option key={count} value={count}>{t('photos.recentCountOption', { count })}</option>)}
              </HomeToolbarSelect>
            </div>
          </>}
          {(photoView || activeTab === 'albums') && <div className="home-control thumbnail-size-setting">
            <span className="home-control-label">{t('photos.thumbnailSize')}</span>
            <HomeThumbnailSizeControl />
          </div>}
        </div>
      </div>}
      <section className="home-content" aria-label={t('home.sections')}>
        {showExport ? <ExportManagementContent management={exportManagement} /> : <>
        {(queueFailure || !!exportQueue.error) && <p className="home-queue-error gallery-message error-text" role="alert">
          {t(`photos.exportQueue.${queueFailure ?? 'loadFailed'}`)}
        </p>}
        {workspaceOpenError && <p className="gallery-message error-text" role="alert">{t(workspaceOpenError === 'unavailable' ? 'photos.workspaceUnavailable' : 'photos.workspaceEmpty')}</p>}
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
        </>}
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
