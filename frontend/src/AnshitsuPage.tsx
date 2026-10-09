import { useAppSettings } from './appSettings';
import { useWorkspaceGpu } from './useWorkspaceGpu';
import { SettingsButton, useSettingsDialog } from './SettingsDialog';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { activeAdjustmentId, focusAdjustmentCategory, navigateAdjustments, restoreAdjustmentFocus } from './adjustmentFocus';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchAssetDetail, isRecentAsset } from './api';
import type { AssetDetail, AssetExif, RecentAsset, WorkspaceNavigationState } from './assets';
import { useEditStatuses } from './useEditStatuses';
import { useExportQueue } from './useExportQueue';
import { ExportQueueApiError } from './exportQueueApi';
import { HomeTitle } from './HomeTitle';
import { ImageViewer } from './ImageViewer';
import { EditHistory } from './EditHistory';
import { Filmstrip } from './Filmstrip';
import { WorkspaceLayout } from './WorkspaceLayout';
import { formatPhotoDate, type AppLanguage } from './i18n';
import { activateWorkspaceAsset, workspacePath } from './photoSelection';
import { readHomeReturn } from './homeReturn';
import { WhiteBalanceAdjustmentControls } from './WhiteBalanceAdjustmentControls';
import { BasicAdjustmentControls } from './BasicAdjustmentControls';
import { ColorAdjustmentControls } from './ColorAdjustmentControls';
import { ColorGradingAdjustmentControls, type GradingRangeMenuTarget } from './ColorGradingAdjustmentControls';
import { isWhiteBalanceDefault, isBasicDefault, isColorDefault, isColorGradingDefault, supportsEditing } from './editing';
import { useJpegOriginal } from './useJpegOriginal';
import type { JpegProfile } from './jpegProfile';
import type { AssetHistograms, ImageHistograms } from './histogram';
import { ScopePanel } from './ScopePanel';
import { ScopeResizeHandle } from './ScopeResizeHandle';
import { readScopePanelBasis, saveScopePanelBasis } from './scopeSizing';
import { EditStateApiError, type EditStateApiErrorKind } from './editStateApi';
import { useAssetEdits } from './useAssetEdits';
import { copyEditSettings, readEditClipboard, selectEditClipboardItems, type EditClipboard } from './editClipboard';
import { GRADING_RANGE_CONTROLS, ADJUSTMENT_IDS, ADJUSTMENT_TOGGLE_IDS, defaultRecipe, recipesEqual, type AdjustmentId } from './editing';
import { HistoryOrganizationMenu, HistoryConfirmationDialog, type HistoryMenuTarget, type HistoryOperation } from './HistoryOrganizationUI';
import { AdjustmentSelectionDialog } from './AdjustmentSelectionDialog';
import { AdjustmentCategoryMenu, type AdjustmentCategoryMenuTarget } from './AdjustmentCategoryMenu';
import { ADJUSTMENT_SELECTION_CATEGORIES, type AdjustmentCategoryId } from './adjustmentSelection';
import type { AdjustmentSliderMenuTarget } from './AdjustmentSlider';
import { AdjustmentContextMenu } from './AdjustmentContextMenu';
import { editClipboardShortcut, isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { rememberWorkspaceSession } from './workspaceResume';
import { useShortcutDisplay } from './useShortcutDisplay';
import { frontendLogger } from './frontendLogging';

type DetailState = 'loading' | 'ready' | 'error';
type SelectionRequest = { mode: 'copy'; assetId: string }
  | { mode: 'paste'; assetId: string; clipboard: EditClipboard };

function logExclusion(event: 'start' | 'complete' | 'failed' | 'undo', context: Record<string, string | number>) {
  try {
    frontendLogger.add({ level: event === 'failed' ? 'error' : 'info', component: 'AnshitsuPage',
      event: `filmstrip.exclude.${event}`, context });
  } catch { /* Diagnostics must not change saving, exclusion or restoration. */ }
}

export function AnshitsuPage() {
  const shortcut = useShortcutDisplay();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { assetId = '' } = useParams();
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const initialNavigation = useMemo(() => readNavigationState(location.state), [location.state]);
  // Preserve selection order for the Filmstrip while the route identifies the active asset.
  const [selectedAssets, setSelectedAssets] = useState<RecentAsset[]>(initialNavigation?.selectedAssets ?? []);
  // Keep the original selection for Gallery resume; exclusions belong only to this mounted workspace.
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() => new Set());
  const excludedIdsRef = useRef(excludedIds);
  excludedIdsRef.current = excludedIds;
  const visibleAssets = selectedAssets.filter(asset => !excludedIds.has(asset.id));
  const exclusionUndo = useRef<{ asset: RecentAsset; index: number; order: string[]; anchorAssetId: string; wasActive: boolean } | null>(null);
  const clearExclusionUndo = () => { exclusionUndo.current = null; };
  const undoExclusionRef = useRef<() => boolean>(() => false);
  const excludeRef = useRef<(id: string) => Promise<void>>(async () => {});
  const exclusionBusy = useRef(false);
  const [excluding, setExcluding] = useState(false);
  const [excludeFailure, setExcludeFailure] = useState(false);
  const activeRouteRef = useRef(assetId);
  activeRouteRef.current = assetId;
  const savedEditStatuses = useEditStatuses(selectedAssets.map(asset => asset.id));
  const exportQueue = useExportQueue();
  const queueToggleRef = useRef<(id: string) => Promise<void>>(async () => {});
  const queueOperations = useRef(new Set<string>());
  const [queueBusy, setQueueBusy] = useState<Set<string>>(() => new Set());
  const [queueFailure, setQueueFailure] = useState<'addFailed' | 'removeFailed' | 'notEligible' | null>(null);
  const queueMounted = useRef(true);
  useEffect(() => {
    queueMounted.current = true;
    return () => { queueMounted.current = false; };
  }, []);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('loading');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [viewerFocusMode, setViewerFocusMode] = useState(false);
  const exitToHomeRef = useRef<() => Promise<void>>(async () => {});
  const [scopePanelBasis, setScopePanelBasis] = useState(readScopePanelBasis);
  const [persistentBeforeAdjustments, setPersistentBeforeAdjustments] = useState(false);
  // Scope needs the effective Viewer state because the persistent choice omits held Backslash.
  const [viewerShowsBefore, setViewerShowsBefore] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const [failedSwitch, setFailedSwitch] = useState<{ nextId: string; error: EditStateApiErrorKind; code?: string } | null>(null);
  const [exitSaving, setExitSaving] = useState(false);
  const exitRef = useRef(false);
  const [exitFailure, setExitFailure] = useState<{ assetId: string; error: EditStateApiErrorKind; code?: string } | null>(null);
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [historyMenu, setHistoryMenu] = useState<HistoryMenuTarget | null>(null);
  const [categoryMenu, setCategoryMenu] = useState<AdjustmentCategoryMenuTarget | null>(null);
  const [rangeMenu, setRangeMenu] = useState<GradingRangeMenuTarget | null>(null);
  const rangeDefinition = GRADING_RANGE_CONTROLS.find(range => range.id === rangeMenu?.rangeId);
  const [sliderMenu, setSliderMenu] = useState<AdjustmentSliderMenuTarget | null>(null);
  const [historyConfirmation, setHistoryConfirmation] = useState<{ assetId: string; operation: 'clearHistory' | 'resetEdits'; trigger: HTMLElement } | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [hasClipboard, setHasClipboard] = useState(() => readEditClipboard() !== null);
  const activeDetail = detail?.id === assetId ? detail : null;
  const settings = useAppSettings();
  const { isOpen: settingsOpen, publishGpu } = useSettingsDialog();
  const workspaceKeyboardBlocked = settingsOpen || selection !== null || historyMenu !== null || categoryMenu !== null || sliderMenu !== null || rangeMenu !== null || historyConfirmation !== null
    || switching || excluding || exitSaving || exitFailure !== null || failedSwitch !== null;
  const [initialGpu, setInitialGpu] = useState<{ assetId: string; usable: boolean } | null>(null);
  const jpegOriginal = useJpegOriginal(activeDetail, settings.initialImage, initialGpu?.assetId === assetId && initialGpu.usable);
  const canEdit = !!activeDetail && supportsEditing(activeDetail);
  const { session, dispatch, canUndo, organizeHistory, loadStatus, save, discard, retryLoad, pauseAutosave, resumeAutosave, autosaveError,
    saveEditedAssetsForExit, resumeAfterExitFailure, localStateFor, retainForUndo } = useAssetEdits(assetId, canEdit, workspaceKeyboardBlocked, {
      onEdit: clearExclusionUndo, undo: () => undoExclusionRef.current(),
    });
  const editable = canEdit && loadStatus === 'ready';
  const seenSaveRevisions = useRef(new Map<string, number>());
  useEffect(() => {
    let cleanupMayHaveChangedQueue = false;
    for (const asset of selectedAssets) {
      const state = localStateFor(asset.id);
      if (state.revision === undefined || state.savedNonDefaultRecipe === undefined) continue;
      const previous = seenSaveRevisions.current.get(asset.id);
      seenSaveRevisions.current.set(asset.id, state.revision);
      // A confirmed default save also removes Queue membership in the Backend transaction.
      if (previous !== undefined && state.revision > previous && !state.savedNonDefaultRecipe
        && exportQueue.hasAsset(asset.id) !== false) cleanupMayHaveChangedQueue = true;
    }
    if (cleanupMayHaveChangedQueue) void exportQueue.refresh();
  });

  async function toggleQueue(id: string) {
    if (workspaceKeyboardBlocked || switchingRef.current || exitRef.current || !exportQueue.loaded || !exportQueue.canonical
      || queueOperations.current.has(id) || exportQueue.mutationFor(id).operation) return;
    const status = exportQueue.getStatus(id);
    if (status === 'waiting' || status === 'encoding' || status === 'registering') return;
    const removing = status === 'queued' || status === 'failed';
    // A default Recipe has no Queue control, even while saved cleanup membership is still refreshing.
    if (localStateFor(id).nonDefaultRecipe === false) return;
    if (!removing && id === assetId && !editable) return;
    queueOperations.current.add(id);
    setQueueBusy(new Set(queueOperations.current));
    setQueueFailure(null);
    try {
      if (removing) {
        await exportQueue.dequeue(id);
      } else {
        const before = localStateFor(id);
        if (before.dirty || before.saving) {
          if (!before.canSave) throw new Error('Save unavailable');
          const saved = await save(id);
          if (!saved.ok || !saved.clean) throw new Error('Save not confirmed');
        }
        if (!queueMounted.current) return;
        const after = localStateFor(id);
        if (after.nonDefaultRecipe === false) {
          setQueueFailure('notEligible');
          return;
        }
        // Unvisited assets use persisted eligibility; no additional edit-state GET is needed.
        await exportQueue.enqueue([id]);
      }
    } catch (cause) {
      if (queueMounted.current) setQueueFailure(cause instanceof ExportQueueApiError && cause.kind === 'not_eligible'
        ? 'notEligible' : removing ? 'removeFailed' : 'addFailed');
    } finally {
      queueOperations.current.delete(id);
      if (queueMounted.current) setQueueBusy(new Set(queueOperations.current));
    }
  }
  queueToggleRef.current = toggleQueue;
  const [histograms, setHistograms] = useState<AssetHistograms | null>(null);
  const histogramSourceKey = editable && jpegOriginal.source ? `${jpegOriginal.source.kind}:${jpegOriginal.source.url}` : null;
  const gpu = useWorkspaceGpu(`${assetId}:${histogramSourceKey ?? 'none'}`);
  useEffect(() => {
    // Preserve source-bound GPU ownership so an old render cannot overlap a new source upload.
    // Original promotion is latched by useJpegOriginal while the new renderer prepares.
    setInitialGpu({ assetId, usable: gpu.enabled && gpu.availability === 'available' && !!gpu.renderer });
  }, [assetId, gpu.enabled, gpu.availability, gpu.renderer]);
  useEffect(() => {
    publishGpu({ enabled: gpu.enabled, availability: gpu.availability, active: gpu.active, setPreference: gpu.setPreference });
  }, [publishGpu, gpu.enabled, gpu.availability, gpu.active, gpu.setPreference]);
  useEffect(() => () => publishGpu(null), [publishGpu]);
  const currentHistogramAsset = useRef({ assetId, sourceKey: histogramSourceKey });
  currentHistogramAsset.current = { assetId, sourceKey: histogramSourceKey };
  // H2 can pass this guarded snapshot to ScopePanel; route changes hide old data immediately.
  const activeHistograms = histograms?.assetId === assetId && histograms.sourceKey === histogramSourceKey
    ? histograms : null;
  const receiveHistograms = useCallback((next: ImageHistograms) => {
    if (currentHistogramAsset.current.assetId !== assetId
      || currentHistogramAsset.current.sourceKey !== next.sourceKey) return;
    setHistograms({ ...next, assetId });
  }, [assetId]);
  useEffect(() => { setHistograms(null); }, [assetId, histogramSourceKey]);
  const clipboardEnabled = editable && !switching && !exitSaving && !failedSwitch && !exitFailure;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (workspaceKeyboardBlocked || event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
      const isFocusToggle = matchesShortcut(event, 'viewerFocusMode');
      const isHomeExit = matchesShortcut(event, 'workspaceReturnHome');
      const isQueueToggle = matchesShortcut(event, 'exportQueueToggle');
      const isExclude = matchesShortcut(event, 'filmstripExclude');
      if (!isFocusToggle && !isHomeExit && !isQueueToggle && !isExclude) return;
      event.preventDefault();
      if (isExclude) void excludeRef.current(assetId);
      else if (isQueueToggle) void queueToggleRef.current(assetId);
      else if (isHomeExit) void exitToHomeRef.current();
      else setViewerFocusMode(current => !current);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [assetId, workspaceKeyboardBlocked]);
  const historyEnabled = clipboardEnabled && selection === null && historyConfirmation === null;
  const canResetHistory = session.history.length > 0 || !recipesEqual(session.recipe, defaultRecipe());
  const selectedOperationPanelRef = useRef<HTMLElement>(null);
  const lastFocusedAdjustment = useRef<AdjustmentId | null>(null);
  const closeHistoryMenu = useCallback(() => setHistoryMenu(null), []);
  const basicResetDisabled = isBasicDefault(session.recipe.adjustments);
  const colorGradingResetDisabled = isColorGradingDefault(session.recipe.adjustments);
  const colorResetDisabled = isColorDefault(session.recipe.adjustments);
  const closeCategoryMenu = useCallback(() => setCategoryMenu(null), []);
  const closeRangeMenu = useCallback(() => setRangeMenu(null), []);
  const closeSliderMenu = useCallback(() => setSliderMenu(null), []);

  useEffect(() => { setSelection(null); setHistoryMenu(null); setCategoryMenu(null); setSliderMenu(null); setRangeMenu(null); setHistoryConfirmation(null); setHistoryError(false); }, [assetId]);
  useEffect(() => {
    if (!historyEnabled) { setHistoryMenu(null); setCategoryMenu(null); setSliderMenu(null); setRangeMenu(null); }
    if (!clipboardEnabled) setHistoryConfirmation(null);
  }, [historyEnabled, clipboardEnabled]);

  function openHistoryMenu(cursor: number | undefined, trigger: HTMLElement, x?: number, y?: number) {
    if (!historyEnabled || switchingRef.current || exitRef.current) return;
    setCategoryMenu(null);
    setSliderMenu(null); setRangeMenu(null);
    const rect = trigger.getBoundingClientRect();
    setHistoryMenu({ assetId, cursor, trigger, x: x ?? rect.left, y: y ?? rect.bottom });
  }

  function openCategoryMenu(categoryId: AdjustmentCategoryId, trigger: HTMLElement, x: number, y: number) {
    if (!historyEnabled || switchingRef.current || exitRef.current) return;
    setHistoryMenu(null);
    setSliderMenu(null); setRangeMenu(null);
    setCategoryMenu({ categoryId, trigger, x, y });
  }

  function openSliderMenu(target: AdjustmentSliderMenuTarget) {
    if (!historyEnabled || switchingRef.current || exitRef.current) return;
    setHistoryMenu(null);
    setCategoryMenu(null);
    setRangeMenu(null);
    setSliderMenu(target);
  }

  function openRangeMenu(target: GradingRangeMenuTarget) {
    if (!historyEnabled || switchingRef.current || exitRef.current) return;
    setHistoryMenu(null); setCategoryMenu(null); setSliderMenu(null); setRangeMenu(target);
  }

  function requestHistoryOperation(operation: HistoryOperation) {
    if (!historyMenu || historyMenu.assetId !== assetId || !historyEnabled || switchingRef.current || exitRef.current) return;
    setHistoryError(false);
    if (operation === 'clearHistory' || operation === 'resetEdits') {
      setHistoryConfirmation({ assetId, operation, trigger: historyMenu.trigger });
    } else if (!organizeHistory(operation, historyMenu.cursor)) setHistoryError(true);
  }

  function confirmHistoryOperation() {
    const request = historyConfirmation;
    if (request && request.assetId === assetId && clipboardEnabled && !selection && !switchingRef.current && !exitRef.current) {
      if (!organizeHistory(request.operation)) setHistoryError(true);
    }
    setHistoryConfirmation(null);
  }

  function copySettings(ids: readonly AdjustmentId[] = ADJUSTMENT_IDS) {
    if (!clipboardEnabled || switchingRef.current || exitRef.current || selection || historyConfirmation || !activeDetail) return false;
    copyEditSettings(session.recipe, assetId, activeDetail.filename, ids);
    setHasClipboard(true);
    return true;
  }

  function pasteSettings(ids?: readonly AdjustmentId[]) {
    if (!clipboardEnabled || switchingRef.current || exitRef.current || selection || historyConfirmation) return false;
    const clipboard = readEditClipboard();
    if (!clipboard) return false;
    const selected = ids ? selectEditClipboardItems(clipboard, ids) : clipboard;
    if (ids && !ids.some((id) => Object.hasOwn(selected.values, id))) return false;
    dispatch({ type: 'paste', ...selected });
    return true;
  }

  function pasteCategorySettings(categoryId: AdjustmentCategoryId) {
    const category = ADJUSTMENT_SELECTION_CATEGORIES.find(({ id }) => id === categoryId);
    return category ? pasteSettings(category.ids) : false;
  }

  function toggleAdjustmentCategory(categoryId: AdjustmentCategoryId) {
    const actions = {
      whiteBalance: () => dispatch({ type: 'toggleWhiteBalance' }),
      basic: () => dispatch({ type: 'toggleBasic' }),
      color: () => dispatch({ type: 'toggleColor' }),
      colorGrading: () => dispatch({ type: 'toggleColorGrading' }),
    } satisfies Record<AdjustmentCategoryId, () => void>;
    actions[categoryId]();
  }

  function resetAdjustmentCategory(categoryId: AdjustmentCategoryId) {
    const actions = {
      whiteBalance: () => dispatch({ type: 'whiteBalanceReset' }),
      basic: () => dispatch({ type: 'basicReset' }),
      color: () => dispatch({ type: 'colorReset' }),
      colorGrading: () => dispatch({ type: 'colorGradingReset' }),
    } satisfies Record<AdjustmentCategoryId, () => void>;
    actions[categoryId]();
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const shortcut = editClipboardShortcut(event);
      if (!shortcut || isNativeEditingTarget(event.target)) return;
      // Copy is contextual to the focused category or slider. Paste is
      // contextual to the active photo and must also work after photo changes
      // when no slider or preview has regained focus.
      if (shortcut === 'copy') {
        const rangeTitle = event.target instanceof Element ? event.target.closest<HTMLElement>('.grading-range-title') : null;
        if (rangeTitle) {
          const range = GRADING_RANGE_CONTROLS.find(range => range.id === rangeTitle.dataset.gradingRangeId);
          if (range && copySettings(range.ids)) event.preventDefault();
          return;
        }
        const categoryTitle = event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('.adjustment-category-title') : null;
        const categoryId = categoryTitle?.dataset.adjustmentCategoryId as AdjustmentCategoryId | undefined;
        const category = categoryId && ADJUSTMENT_SELECTION_CATEGORIES.find(({ id }) => id === categoryId);
        if (categoryTitle) {
          if (category && copySettings(category.ids)) event.preventDefault();
          return;
        }
        const adjustmentId = activeAdjustmentId();
        if (adjustmentId && copySettings([adjustmentId])) event.preventDefault();
        return;
      }
      if (pasteSettings()) event.preventDefault();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [copySettings, pasteSettings]);

  function openSelection(mode: 'copy' | 'paste') {
    if (!clipboardEnabled || switchingRef.current || exitRef.current || selection || historyConfirmation) return false;
    if (mode === 'copy') setSelection({ mode, assetId });
    else {
      const clipboard = readEditClipboard();
      if (!clipboard || !ADJUSTMENT_IDS.some((id) => Object.hasOwn(clipboard.values, id))) return false;
      setSelection({ mode, assetId, clipboard });
    }
    return true;
  }

  function confirmSelection(ids: AdjustmentId[]) {
    if (!selection || selection.assetId !== assetId || !clipboardEnabled
      || switchingRef.current || exitRef.current || ids.length === 0 || !activeDetail) return;
    if (selection.mode === 'copy') {
      copyEditSettings(session.recipe, assetId, activeDetail.filename, ids);
      setHasClipboard(true);
    } else dispatch({ type: 'paste', ...selectEditClipboardItems(selection.clipboard, ids) });
    setSelection(null);
  }

  function navigateToAsset(nextId: string) {
    const currentState: WorkspaceNavigationState = { selectedAssets, activeAssetId: assetId, homeReturn: initialNavigation?.homeReturn };
    const nextState = activateWorkspaceAsset(currentState, nextId);
    navigate(workspacePath(nextState.activeAssetId), { state: nextState });
  }

  async function activateAsset(nextId: string) {
    if (nextId === assetId || switchingRef.current || exclusionBusy.current || exitRef.current || failedSwitch
      || excludedIdsRef.current.has(nextId)) return;
    clearExclusionUndo();
    if (!editable) { navigateToAsset(nextId); return; }
    switchingRef.current = true;
    pauseAutosave(assetId);
    setSwitching(true);
    try {
      // An edit made while PUT is in flight must be saved by a subsequent PUT before leaving.
      for (;;) {
        const result = await save(assetId);
        if (!result.ok) {
          setFailedSwitch({ nextId, error: result.error.kind, code: result.error.code });
          return;
        }
        if (result.clean) {
          navigateToAsset(nextId);
          return;
        }
      }
    } catch {
      setFailedSwitch({ nextId, error: 'unexpected' });
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }

  async function exitToHome() {
    if (exitRef.current || switchingRef.current || exclusionBusy.current || failedSwitch) return;
    clearExclusionUndo();
    exitRef.current = true;
    setExitSaving(true);
    try {
      const result = await saveEditedAssetsForExit();
      if (!result.ok) {
        setExitFailure({ assetId: result.assetId, error: result.error.kind, code: result.error.code });
        setExitSaving(false);
        return;
      }
      returnToHome();
    } catch {
      setExitFailure({ assetId, error: 'unexpected' });
      setExitSaving(false);
    }
  }
  exitToHomeRef.current = exitToHome;

  function stayInAnshitsu() {
    resumeAfterExitFailure();
    exitRef.current = false;
    setExitFailure(null);
    setExitSaving(false);
  }

  function returnToHome() {
    clearExclusionUndo();
    rememberWorkspaceSession({ selectedAssets, activeAssetId: assetId, homeReturn: initialNavigation?.homeReturn });
    navigate('/', { state: initialNavigation?.homeReturn ? { homeReturn: initialNavigation.homeReturn } : null });
  }

  async function excludeAsset(id: string) {
    const index = visibleAssets.findIndex(asset => asset.id === id);
    if (workspaceKeyboardBlocked || exclusionBusy.current || switchingRef.current || exitRef.current
      || visibleAssets.length <= 1 || index < 0 || localStateFor(id).saving
      || queueOperations.current.has(id) || (id === assetId && canEdit && !editable)) return;
    clearExclusionUndo();
    exclusionBusy.current = true;
    setExcluding(true);
    setExcludeFailure(false);
    pauseAutosave(id);
    logExclusion('start', { assetId: id });
    try {
      // Unvisited assets have no local edits to save. Validated inactive records use the same save boundary.
      const local = localStateFor(id);
      if (local.dirty && !local.canSave) throw new EditStateApiError('invalid_state');
      if (local.canSave) {
        for (;;) {
          const result = await save(id);
          if (!result.ok) throw result.error;
          if (result.clean) break;
        }
      }
      if (!queueMounted.current || activeRouteRef.current !== assetId) return;
      const nextExcluded = new Set(excludedIdsRef.current).add(id);
      excludedIdsRef.current = nextExcluded;
      setExcludedIds(nextExcluded);
      const destination = id === assetId ? (visibleAssets[index + 1] ?? visibleAssets[index - 1]).id : assetId;
      exclusionUndo.current = {
        asset: visibleAssets[index], index, order: visibleAssets.map(asset => asset.id), anchorAssetId: destination,
        wasActive: id === assetId,
      };
      if (id === assetId) {
        // Automatic removal navigation must preserve the newly created workspace Undo.
        navigateToAsset(destination);
      }
      logExclusion('complete', { assetId: id, remainingCount: visibleAssets.length - 1 });
    } catch (cause) {
      if (queueMounted.current) setExcludeFailure(true);
      logExclusion('failed', {
        assetId: id, errorCode: cause instanceof EditStateApiError ? cause.kind : 'unexpected',
      });
    } finally {
      resumeAutosave(id);
      exclusionBusy.current = false;
      if (queueMounted.current) setExcluding(false);
    }
  }
  excludeRef.current = excludeAsset;
  undoExclusionRef.current = () => {
    const undo = exclusionUndo.current;
    if (!undo || workspaceKeyboardBlocked || exclusionBusy.current || switchingRef.current || exitRef.current) return false;
    clearExclusionUndo();
    const nextExcluded = new Set(excludedIdsRef.current);
    nextExcluded.delete(undo.asset.id);
    excludedIdsRef.current = nextExcluded;
    setExcludedIds(nextExcluded);
    // Reuse the confirmed in-memory Recipe/History, including its cursor, for this one restoration.
    if (undo.wasActive) {
      retainForUndo(undo.asset.id);
      void activateAsset(undo.asset.id);
    }
    logExclusion('undo', { assetId: undo.asset.id, index: undo.index });
    return true;
  };

  useEffect(() => {
    if (exclusionUndo.current && exclusionUndo.current.anchorAssetId !== assetId) clearExclusionUndo();
  }, [assetId]);

  useEffect(() => {
    if (!excludedIdsRef.current.has(assetId)) return;
    // Browser history may revisit a route created before exclusion; never revive its thumbnail.
    const index = selectedAssets.findIndex(asset => asset.id === assetId);
    const next = selectedAssets.slice(index + 1).find(asset => !excludedIdsRef.current.has(asset.id))
      ?? selectedAssets.slice(0, index).reverse().find(asset => !excludedIdsRef.current.has(asset.id));
    if (next) navigate(workspacePath(next.id), { replace: true, state: {
      selectedAssets, activeAssetId: next.id, homeReturn: initialNavigation?.homeReturn,
    } });
  }, [assetId, selectedAssets, navigate, initialNavigation]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;
    setDetailState('loading');
    setDetail(null);

    void fetchAssetDetail(assetId, controller.signal).then((asset) => {
      if (!active) return;
      setDetail(asset);
      setDetailState('ready');
      setSelectedAssets((current) => {
        const summary = detailToRecent(asset);
        if (excludedIdsRef.current.has(asset.id)) return current;
        return current.some((item) => item.id === asset.id)
          ? current.map((item) => item.id === asset.id ? summary : item)
          : [summary];
      });
    }).catch(() => {
      if (active) setDetailState('error');
    }).finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [assetId]);

  const categoryMenuDefinition = categoryMenu
    ? ADJUSTMENT_SELECTION_CATEGORIES.find(({ id }) => id === categoryMenu.categoryId) : undefined;
  const categoryMenuClipboard = categoryMenuDefinition ? readEditClipboard() : null;
  const categoryMenuPasteDisabled = !categoryMenuDefinition || !categoryMenuClipboard
    || !categoryMenuDefinition.ids.some((id) => Object.hasOwn(categoryMenuClipboard.values, id));
  const categoryMenuState = categoryMenu ? {
    whiteBalance: { enabled: session.recipe.whiteBalanceEnabled, resetDisabled: isWhiteBalanceDefault(session.recipe.adjustments), enableLabel: 'workspace.enableWhiteBalance', disableLabel: 'workspace.disableWhiteBalance' },
    basic: { enabled: session.recipe.basicEnabled, resetDisabled: basicResetDisabled, enableLabel: 'workspace.enableBasic', disableLabel: 'workspace.disableBasic' },
    color: { enabled: session.recipe.colorEnabled, resetDisabled: colorResetDisabled, enableLabel: 'workspace.enableColor', disableLabel: 'workspace.disableColor' },
    colorGrading: { enabled: session.recipe.colorGradingEnabled, resetDisabled: colorGradingResetDisabled, enableLabel: 'workspace.enableColorGrading', disableLabel: 'workspace.disableColorGrading' },
  }[categoryMenu.categoryId] : undefined;
  const summary = detail ? detailToRecent(detail) : selectedAssets.find((asset) => asset.id === assetId);
  const selectedOperationPanel = {
    get element() { return selectedOperationPanelRef.current; },
    restoreFocus: () => selectedOperationPanelRef.current
      ? restoreAdjustmentFocus(selectedOperationPanelRef.current, lastFocusedAdjustment.current) : false,
  };
  function enterSelectedOperationPanel(event: KeyboardEvent) {
    const panel = selectedOperationPanel.element;
    if (!panel || (event.target instanceof Node && panel.contains(event.target)) || !event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)
      || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
      || isNativeEditingTarget(event.target) || !historyEnabled || switchingRef.current || exitRef.current
      || historyMenu || categoryMenu || sliderMenu || rangeMenu
      || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')) return;
    if (selectedOperationPanel.restoreFocus()) event.preventDefault();
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Range hover can release stale focus to body; keep the same entry behavior.
      if (event.target === document.body || event.target === document.documentElement) enterSelectedOperationPanel(event);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [enterSelectedOperationPanel]);
  return <main className={`workspace-page${viewerFocusMode ? ' viewer-focus-mode' : ''}`} onFocus={event => {
    if (event.target instanceof HTMLInputElement && event.target.matches('.adjustment-range')
      && selectedOperationPanelRef.current?.contains(event.target)) {
      lastFocusedAdjustment.current = ADJUSTMENT_IDS.find(id => id === event.target.dataset.adjustmentId) ?? null;
    }
  }} onKeyDown={event => enterSelectedOperationPanel(event.nativeEvent)}>
    <header className="workspace-header">
      <div className="workspace-brand">
        <HomeTitle className="workspace-title-link" disabled={exitSaving || exitFailure !== null}
          onActivate={() => { void exitToHome(); }} />
        <span>{t('workspace.name')}</span>
        {language === 'en' && <small>{t('workspace.subtitle')}</small>}
      </div>
      <div className="workspace-asset-title">
        <span title={summary?.filename}>{summary?.filename ?? t('workspace.loading')}</span>
        {summary && <time dateTime={summary.date}>{formatPhotoDate(summary.date)}</time>}
      </div>
      <div className="workspace-actions">
        <button type="button" className="tool-button" disabled={exitSaving || exitFailure !== null}
          title={shortcut.title(t('workspace.backToPhotos'), 'workspaceReturnHome')}
          onClick={() => { void exitToHome(); }}>{t('workspace.backToPhotos')}</button>
        <SettingsButton />
      </div>
    </header>
    {(queueFailure || !!exportQueue.error) && <p className="workspace-queue-error error-text" role="alert">
      {t(`photos.exportQueue.${queueFailure ?? 'loadFailed'}`)}
    </p>}

    <WorkspaceLayout
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      viewerFocusMode={viewerFocusMode}
      leftPanel={<>
        <WorkspaceSection title={t('workspace.history')} className="left-history-section" headerAction={<button type="button" className="tool-button workspace-section-action history-menu-trigger"
          disabled={!historyEnabled} aria-label={t('workspace.historyMenu')} aria-haspopup="menu" aria-expanded={!!historyMenu}
          onClick={(event) => { if (historyMenu) closeHistoryMenu(); else openHistoryMenu(undefined, event.currentTarget); }}>⋯</button>}>
          <div className="edit-actions">
            <button className="tool-button" title={shortcut.title(t('workspace.undo'), 'undo')} disabled={!historyEnabled || !canUndo} onClick={() => dispatch({ type: 'undo' })}>{t('workspace.undo')}</button>
            <button className="tool-button" title={shortcut.title(t('workspace.redo'), 'redo')} disabled={!historyEnabled || session.cursor >= session.history.length || !!session.pending} onClick={() => dispatch({ type: 'redo' })}>{t('workspace.redo')}</button>
          </div>
          <div className="history-scroll-region">
          {session.history.length === 0 ? <p>{t('workspace.historyEmpty')}</p>
            : <EditHistory history={session.history} cursor={session.cursor} disabled={!historyEnabled}
              onMenu={(cursor, trigger, x, y) => openHistoryMenu(cursor, trigger, x, y)}
              onJump={(cursor) => { if (historyEnabled) dispatch({ type: 'jumpToHistory', cursor }); }} />}
          </div>
        </WorkspaceSection>
        <ExifSection>
          {activeDetail ? <ExifDetails exif={activeDetail.exif} fallbackDate={activeDetail.date} language={language}
            profile={jpegOriginal.profile} />
            : <p>{detailState === 'error' ? t('workspace.detailFailed') : t('workspace.loading')}</p>}
        </ExifSection>
      </>}
      viewer={detailState === 'ready' && activeDetail ? (
        <ImageViewer gpuRenderer={gpu.renderer} onGpuError={gpu.fail} onBackendChange={gpu.reportBackend}
          key={assetId}
          src={activeDetail.preview_url}
          editSource={editable ? jpegOriginal.source : undefined}
          originalStatus={jpegOriginal.status}
          showingOriginal={jpegOriginal.showingOriginal}
          onOriginalToggle={jpegOriginal.toggle}
          onImageError={jpegOriginal.failDecode}
          recipe={editable ? session.recipe : undefined}
          onHistogramChange={receiveHistograms}
          alt={activeDetail.filename}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          persistentBeforeAdjustments={persistentBeforeAdjustments}
          onBeforeAdjustmentsChange={setPersistentBeforeAdjustments}
          onBeforeAdjustmentsDisplayChange={setViewerShowsBefore}
          onToggleLeft={() => setLeftOpen((value) => !value)}
          onToggleRight={() => setRightOpen((value) => !value)}
          onCopyAdjustments={() => copySettings()}
          onPasteAdjustments={pasteSettings}
          onSelectCopyAdjustments={() => openSelection('copy')}
          onSelectPasteAdjustments={() => openSelection('paste')}
          editClipboardDisabled={!clipboardEnabled || selection !== null || historyConfirmation !== null}
          hasEditClipboard={hasClipboard}
          keyboardBlocked={workspaceKeyboardBlocked}
        />
      ) : (
        <section className="viewer-panel viewer-message" aria-live="polite">
          <div className="viewer-toolbar">
            <button type="button" className="tool-button panel-toggle" onClick={() => setLeftOpen((value) => !value)} aria-label={t(leftOpen ? 'workspace.collapseLeft' : 'workspace.expandLeft')}>{leftOpen ? '‹' : '›'} <span>{t('workspace.history')}</span></button>
            <button type="button" className="tool-button panel-toggle right" onClick={() => setRightOpen((value) => !value)} aria-label={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')}><span>{t('workspace.developControls')}</span> {rightOpen ? '›' : '‹'}</button>
          </div>
          <p className={detailState === 'error' ? 'error-text' : ''}>{t(detailState === 'error' ? 'workspace.detailFailed' : 'workspace.loading')}</p>
        </section>
      )}
      rightPanel={<>
        <WorkspaceSection title={t('workspace.scope')} className="scope-section"
          style={{ '--scope-panel-basis': `${scopePanelBasis}%` } as CSSProperties}
          headerAction={<select className="scope-type-select" aria-label={t('workspace.scopeType')} defaultValue="histogram">
            <option value="histogram">{t('workspace.histogram')}</option>
          </select>}>
          <ScopePanel histogram={activeHistograms?.[viewerShowsBefore ? 'before' : 'after'] ?? null}
            keyboardBlocked={!editable || workspaceKeyboardBlocked} />
        </WorkspaceSection>
        <ScopeResizeHandle value={scopePanelBasis} onChange={setScopePanelBasis} onCommit={saveScopePanelBasis} label={t('workspace.resizeScope')} />
        <DevelopPanel panelRef={selectedOperationPanelRef} headerAction={editable
          ? <button type="button" className="tool-button workspace-section-action" onClick={() => dispatch({ type: 'allReset' })}>{t('workspace.allReset')}</button>
          : undefined}>
          {editable ? <>
            <AdjustmentCategory categoryId="whiteBalance" onOpenContextMenu={openCategoryMenu}
              title={t('workspace.whiteBalance')} enabled={session.recipe.whiteBalanceEnabled}
              resetDisabled={isWhiteBalanceDefault(session.recipe.adjustments)}
              enableLabel={t('workspace.enableWhiteBalance')} disableLabel={t('workspace.disableWhiteBalance')}
              expandLabel={t('workspace.expandWhiteBalance')} collapseLabel={t('workspace.collapseWhiteBalance')}
              resetLabel={t('workspace.reset')}
              onToggle={() => dispatch({ type: 'toggleWhiteBalance' })}
              onReset={() => dispatch({ type: 'whiteBalanceReset' })}>
              <WhiteBalanceAdjustmentControls assetId={assetId} recipe={session.recipe} dispatch={dispatch} onOpenContextMenu={openSliderMenu} />
            </AdjustmentCategory>
            <AdjustmentCategory categoryId="basic" onOpenContextMenu={openCategoryMenu}
              title={t('workspace.basic')} enabled={session.recipe.basicEnabled}
              resetDisabled={basicResetDisabled}
              enableLabel={t('workspace.enableBasic')} disableLabel={t('workspace.disableBasic')}
              expandLabel={t('workspace.expandBasic')} collapseLabel={t('workspace.collapseBasic')}
              resetLabel={t('workspace.reset')}
              onToggle={() => dispatch({ type: 'toggleBasic' })}
              onReset={() => dispatch({ type: 'basicReset' })}>
              <BasicAdjustmentControls assetId={assetId} recipe={session.recipe} dispatch={dispatch} onOpenContextMenu={openSliderMenu} />
            </AdjustmentCategory>
            <AdjustmentCategory categoryId="color" onOpenContextMenu={openCategoryMenu}
              title={t('workspace.color')} enabled={session.recipe.colorEnabled}
              resetDisabled={colorResetDisabled}
              enableLabel={t('workspace.enableColor')} disableLabel={t('workspace.disableColor')}
              expandLabel={t('workspace.expandColor')} collapseLabel={t('workspace.collapseColor')}
              resetLabel={t('workspace.reset')}
              onToggle={() => dispatch({ type: 'toggleColor' })}
              onReset={() => dispatch({ type: 'colorReset' })}>
              <ColorAdjustmentControls assetId={assetId} recipe={session.recipe} dispatch={dispatch} onOpenContextMenu={openSliderMenu} />
            </AdjustmentCategory>
            <AdjustmentCategory categoryId="colorGrading" onOpenContextMenu={openCategoryMenu}
              title={t('workspace.colorGrading')} enabled={session.recipe.colorGradingEnabled}
              resetDisabled={colorGradingResetDisabled}
              enableLabel={t('workspace.enableColorGrading')} disableLabel={t('workspace.disableColorGrading')}
              expandLabel={t('workspace.expandColorGrading')} collapseLabel={t('workspace.collapseColorGrading')}
              resetLabel={t('workspace.reset')}
              onToggle={() => dispatch({ type: 'toggleColorGrading' })}
              onReset={() => dispatch({ type: 'colorGradingReset' })}>
              <ColorGradingAdjustmentControls assetId={assetId} recipe={session.recipe} dispatch={dispatch} onOpenContextMenu={openSliderMenu} onOpenRangeMenu={openRangeMenu} />
            </AdjustmentCategory>
            <p className="edit-source-note">{t('workspace.previewEditingNote')}</p>
          </> : canEdit ? <div role="status" className={loadStatus === 'error' ? 'error-text' : undefined}>
            <p>{t(loadStatus === 'error' ? 'workspace.editStateLoadFailed' : 'workspace.editStateLoading')}</p>
            {loadStatus === 'error' && <button type="button" className="tool-button" onClick={retryLoad}>{t('workspace.retry')}</button>}
          </div> : <p>{t('workspace.jpegOnly')}</p>}
        </DevelopPanel>
      </>}
      filmstrip={<Filmstrip
        assets={visibleAssets}
        editStatuses={Object.fromEntries(selectedAssets.map(asset => [asset.id, localStateFor(asset.id, savedEditStatuses[asset.id]).nonDefaultRecipe]))}
        historyOnlyStatuses={Object.fromEntries(selectedAssets.map(asset => [asset.id, localStateFor(asset.id).historyOnly]))}
        activeAssetId={assetId}
        disabled={switching || excluding || exitSaving || exitFailure !== null || failedSwitch !== null}
        onExclude={id => { void excludeRef.current(id); }}
        excludeDisabled={canEdit && !editable}
        excludeBusyFor={id => !!localStateFor(id).saving || queueBusy.has(id)}
        keyboardBlocked={workspaceKeyboardBlocked}
        queueKnown={exportQueue.loaded}
        queueCurrent={exportQueue.canonical}
        queueStatusFor={exportQueue.getStatus}
        queueBusyFor={id => queueBusy.has(id) || !!exportQueue.mutationFor(id).operation || localStateFor(id).saving}
        onQueueToggle={id => { void queueToggleRef.current(id); }}
        onActivate={(nextId) => { void activateAsset(nextId); }}
      />}
    />
    {rangeMenu && rangeDefinition && historyEnabled && <AdjustmentContextMenu target={rangeMenu}
      className="grading-range-context-menu" menuLabel={t('workspace.gradingRangeMenu', { name: t(rangeDefinition.label) })}
      enabled={session.recipe[rangeDefinition.enabled]}
      resetDisabled={rangeDefinition.ids.every(id => session.recipe.adjustments[id] === 0)}
      pasteDisabled={!rangeDefinition.ids.some(id => Object.hasOwn(readEditClipboard()?.values ?? {}, id))}
      enableLabel={t('workspace.enableAdjustment', { name: t(rangeDefinition.label) })}
      disableLabel={t('workspace.disableAdjustment', { name: t(rangeDefinition.label) })}
      resetLabel={t('workspace.resetGradingRange', { name: t(rangeDefinition.label) })}
      copyLabel={t('workspace.copyGradingRange', { name: t(rangeDefinition.label) })}
      pasteLabel={t('workspace.pasteGradingRange', { name: t(rangeDefinition.label) })}
      onToggle={() => dispatch({ type: rangeDefinition.toggle })} onReset={() => dispatch({ type: rangeDefinition.reset })}
      onCopy={() => { copySettings(rangeDefinition.ids); }} onPaste={() => { pasteSettings(rangeDefinition.ids); }} onClose={closeRangeMenu} />}
    {sliderMenu && historyEnabled && <AdjustmentContextMenu target={sliderMenu}
      className="adjustment-slider-context-menu" menuLabel={t('workspace.adjustmentMenu')}
      enabled={session.recipe.adjustmentEnabled[sliderMenu.adjustmentId]}
      resetDisabled={session.recipe.adjustments[sliderMenu.adjustmentId] === defaultRecipe().adjustments[sliderMenu.adjustmentId]}
      pasteDisabled={!Object.hasOwn(readEditClipboard()?.values ?? {}, sliderMenu.adjustmentId)}
      enableLabel={t('workspace.enableAdjustmentMenu')} disableLabel={t('workspace.disableAdjustmentMenu')}
      resetLabel={t('workspace.resetAdjustment')} copyLabel={t('workspace.copyAdjustment')} pasteLabel={t('workspace.pasteAdjustment')}
      onToggle={() => dispatch({ type: 'toggleAdjustment', id: sliderMenu.adjustmentId })}
      onReset={() => dispatch({ type: `${sliderMenu.adjustmentId}Reset` })}
      onCopy={() => { copySettings([sliderMenu.adjustmentId]); }}
      onPaste={() => { pasteSettings([sliderMenu.adjustmentId]); }} onClose={closeSliderMenu} />}
    {categoryMenu && categoryMenuDefinition && categoryMenuState && historyEnabled && <AdjustmentCategoryMenu
      target={categoryMenu}
      enabled={categoryMenuState.enabled}
      resetDisabled={categoryMenuState.resetDisabled}
      pasteDisabled={categoryMenuPasteDisabled}
      enableLabel={categoryMenuState.enableLabel}
      disableLabel={categoryMenuState.disableLabel}
      resetLabel="workspace.resetCategory"
      copyLabel="workspace.copyCategorySettings"
      pasteLabel="workspace.pasteCategorySettings"
      onToggle={() => toggleAdjustmentCategory(categoryMenu.categoryId)}
      onReset={() => resetAdjustmentCategory(categoryMenu.categoryId)}
      onCopy={() => { copySettings(categoryMenuDefinition.ids); }}
      onPaste={() => { pasteCategorySettings(categoryMenu.categoryId); }}
      onClose={closeCategoryMenu}
    />}
    {selection && selection.assetId === assetId && <AdjustmentSelectionDialog
      mode={selection.mode}
      availableIds={selection.mode === 'copy' ? ADJUSTMENT_IDS
        : ADJUSTMENT_IDS.filter((id) => Object.hasOwn(selection.clipboard.values, id))}
      onConfirm={confirmSelection} onCancel={() => setSelection(null)} />}
    {historyMenu && historyMenu.assetId === assetId && historyEnabled && <HistoryOrganizationMenu target={historyMenu}
      hasHistory={session.history.length > 0} canReset={canResetHistory} onClose={closeHistoryMenu} onSelect={requestHistoryOperation} />}
    {historyConfirmation && historyConfirmation.assetId === assetId && <HistoryConfirmationDialog
      operation={historyConfirmation.operation} returnFocus={historyConfirmation.trigger} onConfirm={confirmHistoryOperation} onCancel={() => setHistoryConfirmation(null)} />}
    {historyError && <p className="workspace-autosave-warning" role="alert">{t('workspace.historyFailed')}</p>}
    {excludeFailure && <p className="workspace-autosave-warning" role="alert">{t('workspace.excludeFailed')}</p>}
    {excluding && <p className="workspace-save-status" role="status">{t('workspace.editStateSaving')}</p>}
    {switching && <p className="workspace-save-status" role="status">{t('workspace.editStateSaving')}</p>}
    {autosaveError && <p className="workspace-autosave-warning" role="alert">{t('workspace.autosaveFailed')}</p>}
    {exitSaving && <div className="workspace-save-backdrop"><section role="status" className="workspace-save-dialog">
      <p>{t('workspace.exitSaving')}</p>
    </section></div>}
    {failedSwitch && <div className="workspace-save-backdrop"><section role="alertdialog" aria-modal="true"
      aria-labelledby="save-failure-title" className="workspace-save-dialog">
      <h2 id="save-failure-title">{t('workspace.editStateSaveFailed')}</h2>
      <p>{t(failedSwitch.code === 'save_id_reused' ? 'workspace.saveError.saveIdConflict' : `workspace.saveError.${failedSwitch.error}`)}</p>
      <div className="edit-actions">
        <button type="button" autoFocus className="tool-button" onClick={() => {
          setFailedSwitch(null);
          resumeAutosave(assetId);
        }}>{t('workspace.stayOnPhoto')}</button>
        <button type="button" className="tool-button" onClick={() => {
          discard(assetId);
          navigateToAsset(failedSwitch.nextId);
          setFailedSwitch(null);
        }}>{t('workspace.moveWithoutSaving')}</button>
      </div>
    </section></div>}
    {exitFailure && <div className="workspace-save-backdrop"><section role="alertdialog" aria-modal="true"
      aria-labelledby="exit-save-failure-title" className="workspace-save-dialog">
      <h2 id="exit-save-failure-title">{t('workspace.exitSaveFailed')}</h2>
      <p>{t(exitFailure.code === 'save_id_reused' ? 'workspace.saveError.saveIdConflict' : `workspace.saveError.${exitFailure.error}`)}</p>
      <div className="edit-actions">
        <button type="button" autoFocus className="tool-button" onClick={stayInAnshitsu}>{t('workspace.stayInAnshitsu')}</button>
        <button type="button" className="tool-button" onClick={returnToHome}>{t('workspace.exitWithoutSaving')}</button>
      </div>
    </section></div>}
  </main>;
}

export function DevelopPanel({ children, headerAction, panelRef }: { children: ReactNode; headerAction?: ReactNode; panelRef?: Ref<HTMLElement> }) {
  const { t } = useTranslation();
  return <WorkspaceSection title={t('workspace.developControls')} className="develop-panel" headerAction={headerAction} sectionRef={panelRef}>
    <div className="develop-scroll-region">{children}</div>
  </WorkspaceSection>;
}

export function ExifSection({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  return <section className="workspace-section left-exif-section">
    <h2 className="exif-heading"><button type="button" className="exif-toggle" aria-expanded={expanded}
      aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
      <span>{t('workspace.originalInfo')}</span><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    </button></h2>
    <div id={contentId} className="workspace-section-content exif-scroll-region" hidden={!expanded}>{children}</div>
  </section>;
}

export function WorkspaceSection({ title, children, grow = false, className = '', headerAction, sectionRef, style }: { title: string; children: ReactNode; grow?: boolean; className?: string; headerAction?: ReactNode; sectionRef?: Ref<HTMLElement>; style?: CSSProperties }) {
  const sectionClassName = `workspace-section${grow ? ' grow' : ''}${className ? ` ${className}` : ''}`;

  return <section ref={sectionRef} className={sectionClassName} style={style}>
    <div className="workspace-section-header">
      <h2>{title}</h2>
      {headerAction}
    </div>
    <div className="workspace-section-content">{children}</div>
  </section>;
}

export function AdjustmentCategory({ categoryId, onOpenContextMenu, title, enabled, resetDisabled, enableLabel, disableLabel, expandLabel, collapseLabel, resetLabel, onToggle, onReset, children }: {
  categoryId?: AdjustmentCategoryId; onOpenContextMenu?: (categoryId: AdjustmentCategoryId, trigger: HTMLElement, x: number, y: number) => void;
  title: string; enabled: boolean; resetDisabled: boolean; enableLabel: string; disableLabel: string;
  expandLabel: string; collapseLabel: string; resetLabel: string; onToggle: () => void; onReset: () => void; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const titleButton = useRef<HTMLButtonElement>(null);
  const toggleExpanded = () => setExpanded((value) => !value);
  return <section className={`adjustment-category${enabled ? '' : ' is-disabled'}`}>
    <div className="adjustment-category-header" onContextMenu={(event) => {
      if (!categoryId || !onOpenContextMenu) return;
      event.preventDefault();
      onOpenContextMenu(categoryId, titleButton.current ?? event.currentTarget, event.clientX, event.clientY);
    }}>
      <h3>
        <button ref={titleButton} type="button" className="adjustment-category-title"
          data-adjustment-category-id={categoryId} aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? collapseLabel : expandLabel}
          onClick={toggleExpanded}
          onFocus={focusAdjustmentCategory}
          onKeyDown={(event) => {
            navigateAdjustments(event.nativeEvent, event.currentTarget);
          }}>
          <span className="adjustment-category-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span className="adjustment-category-label">{title}</span>
        </button>
      </h3>
      <div className="adjustment-category-actions">
        <button type="button" className={`adjustment-category-icon${enabled ? '' : ' is-off'}`}
          data-category-switch
          onFocus={focusAdjustmentCategory}
          onKeyDown={(event) => {
            navigateAdjustments(event.nativeEvent, event.currentTarget);
          }}
          aria-pressed={enabled} aria-label={enabled ? disableLabel : enableLabel}
          title={enabled ? disableLabel : enableLabel} onClick={onToggle}>⏻</button>
        <button type="button" className="adjustment-category-reset" disabled={resetDisabled}
          onFocus={focusAdjustmentCategory}
          onKeyDown={(event) => { navigateAdjustments(event.nativeEvent, event.currentTarget); }}
          onClick={onReset}>{resetLabel}</button>
      </div>
    </div>
    {expanded && <div id={contentId} className="adjustment-category-content">{children}</div>}
  </section>;
}

export function ExifDetails({ exif, fallbackDate, language, profile = { status: 'unknown' } }: { exif: AssetExif; fallbackDate: string; language: AppLanguage; profile?: JpegProfile }) {
  const { t } = useTranslation();
  const rows: Array<[string, string | number | undefined]> = [
    [t('workspace.exif.date'), formatPhotoDate(exif.date_time_original ?? fallbackDate)],
    [t('workspace.exif.make'), exif.make],
    [t('workspace.exif.model'), exif.model],
    [t('workspace.exif.lens'), exif.lens_model],
    [t('workspace.exif.focalLength'), exif.focal_length === undefined ? undefined : `${exif.focal_length} mm`],
    [t('workspace.exif.aperture'), exif.f_number === undefined ? undefined : `f/${exif.f_number}`],
    [t('workspace.exif.shutterSpeed'), exif.exposure_time],
    ['ISO', exif.iso],
    [t('workspace.colorProfile'), profile.status === 'embedded' ? profile.description : t(profile.status === 'none' ? 'workspace.profileNone' : 'workspace.profileUnknown')],
    [t('workspace.exif.exposureCompensation'), exif.exposure_compensation === undefined ? undefined : `${exif.exposure_compensation > 0 ? '+' : ''}${exif.exposure_compensation} EV`],
    [t('workspace.exif.dimensions'), exif.width !== undefined && exif.height !== undefined ? `${exif.width} × ${exif.height}` : undefined],
  ];
  const visibleRows = rows.filter((row): row is [string, string | number] => row[1] !== undefined && row[1] !== '');
  return visibleRows.length > 0 ? <dl className="exif-list">{visibleRows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl> : <p>{t('workspace.exif.empty')}</p>;
}

function readNavigationState(value: unknown): WorkspaceNavigationState | null {
  if (typeof value !== 'object' || value === null || !('selectedAssets' in value) || !('activeAssetId' in value)) return null;
  const state = value as { selectedAssets: unknown; activeAssetId: unknown; homeReturn?: unknown };
  if (!Array.isArray(state.selectedAssets) || !state.selectedAssets.every(isRecentAsset) || typeof state.activeAssetId !== 'string') return null;
  const homeReturn = readHomeReturn(state.homeReturn);
  return { selectedAssets: state.selectedAssets, activeAssetId: state.activeAssetId, ...(homeReturn ? { homeReturn } : {}) };
}

function detailToRecent(asset: AssetDetail): RecentAsset {
  return {
    id: asset.id,
    filename: asset.filename,
    date: asset.date,
    thumbnail_url: asset.thumbnail_url,
    format: asset.format,
    is_raw: asset.is_raw,
  };
}
