import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isRecentAsset } from './api';
import type { RecentAsset } from './assets';
import { useAppSettings } from './appSettings';
import { readHomeReturn, type HomeReturnContext } from './homeReturn';
import { HomeTitle } from './HomeTitle';
import { SettingsButton, useSettingsDialog } from './SettingsDialog';
import { isNativeEditingTarget, matchesShortcut } from './editShortcuts';
import { useShortcutDisplay } from './useShortcutDisplay';
import { FormatBadge } from './FormatBadge';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { useStackCandidateDetection } from './useStackCandidateDetection';
import { useStackColumns } from './useStackColumns';
import { useEditableStackDraft } from './useEditableStackDraft';
import { useSelectedImmichStacks } from './useSelectedImmichStacks';
import { isSingletonImmichStack, mergeImmichStackSource } from './immichStackDraft';
import { StackRedetectDialog } from './StackRedetectDialog';
import type { DraftStack } from './stackCandidateDetection';
import { buildStackWritePlan, sendStackWritePlan, type StackWriteResult } from './stackWrite';
import { canCreateStackFromUnmatchedDrop, canDropStackPayload, isStackDrag, parseStackDragPayload, readStackDragPayload, STACK_DRAG_TYPE, type StackDragPayload } from './stackDragDrop';
import { frontendLogger } from './frontendLogging';

const EMPTY_ASSETS: RecentAsset[] = [];

type DndTarget = { targetKind: 'stack' | 'unmatched-area' | 'unmatched-photo'; targetGroupId: string | null; targetAssetId?: string };
function logStackDnd(event: string, context: Record<string, string | number | boolean | null | string[]>) {
  if (frontendLogger.getLevel() !== 'debug') return;
  try { frontendLogger.add({ level: 'debug', component: 'stack.dnd', event, context }); }
  catch { /* Diagnostics must never interfere with browser drag handling. */ }
}

export type StackNavigationState = { selectedAssets: RecentAsset[]; homeReturn?: HomeReturnContext };

function readNavigation(value: unknown): StackNavigationState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.selectedAssets) || !state.selectedAssets.every(isRecentAsset)) return null;
  const homeReturn = readHomeReturn(state.homeReturn);
  return { selectedAssets: [...new Map(state.selectedAssets.map(asset => [asset.id, asset])).values()], ...(homeReturn ? { homeReturn } : {}) };
}

export function StackManagementPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useMemo(() => readNavigation(location.state), [location.state]);
  const sourceGeneration = `${location.key}:${JSON.stringify(location.state) ?? 'null'}`;
  const assets = navigation?.selectedAssets ?? EMPTY_ASSETS;
  const immich = useSelectedImmichStacks(assets);
  const detectionAssets = useMemo(() => {
    if (immich.loading || immich.error) return EMPTY_ASSETS;
    const memberIds = new Set(immich.stacks.flatMap(stack => stack.assets.map(asset => asset.id.toLowerCase())));
    return assets.filter(asset => (immich.refreshed || asset.stackId == null) && !memberIds.has(asset.id.toLowerCase()))
      .map(asset => immich.refreshed ? { ...asset, stackId: null, primaryAssetId: null, stackAssetCount: null } : asset);
  }, [assets, immich.stacks, immich.loading, immich.error, immich.refreshed]);
  const detection = useStackCandidateDetection(detectionAssets);
  const integration = useMemo(() => mergeImmichStackSource(detection, immich.stacks, assets), [detection.groups, detection.unmatched, immich.stacks, assets]);
  const busy = detection.loading || immich.loading;
  const { draft, dispatch, ready } = useEditableStackDraft(integration.source, busy || immich.error, integration.assets);
  const { selectedIds, addTargetStackId } = draft;
  const [confirmRedetect, setConfirmRedetect] = useState(false);
  const [redetecting, setRedetecting] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<StackDragPayload | null>(null);
  const draggingRef = useRef<StackDragPayload | null>(null);
  const dragPayloadForEndLog = useRef<StackDragPayload | null>(null);
  const dragPreviewRef = useRef<HTMLImageElement | null>(null);
  const nativeDragImageRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewGrabOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const dragoverLogged = useRef(new Map<string, string>());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sendRequest = useRef<{ controller: AbortController; generation: string } | null>(null);
  const currentGeneration = useRef(sourceGeneration);
  const removeDragElement = (element: HTMLElement | null) => {
    try { element?.remove(); } catch { /* Visual cleanup must not affect drag completion. */ }
  };
  const clearDragVisuals = () => {
    removeDragElement(dragPreviewRef.current);
    removeDragElement(nativeDragImageRef.current);
    dragPreviewRef.current = null; nativeDragImageRef.current = null;
    dragPreviewGrabOffsetRef.current = null;
  };
  const moveDragPreview = (clientX: number, clientY: number) => {
    const preview = dragPreviewRef.current;
    const grabOffset = dragPreviewGrabOffsetRef.current;
    if (!preview || !grabOffset) return;
    const x = Number.isFinite(clientX) ? clientX : 0;
    const y = Number.isFinite(clientY) ? clientY : 0;
    preview.style.left = `${x - grabOffset.x}px`;
    preview.style.top = `${y - grabOffset.y}px`;
  };
  useLayoutEffect(() => {
    if (currentGeneration.current === sourceGeneration) return;
    currentGeneration.current = sourceGeneration;
    dispatch({ type: 'clearUndo' });
    sendRequest.current?.controller.abort();
    sendRequest.current = null;
    setSending(false); setSendStatus(null); setConfirmSend(false); setConfirmRedetect(false);
    setRedetecting(false);
    if (draggingRef.current) logStackDnd('drag.cancelled-generation-change', {
      assetId: draggingRef.current.assetId, sourceGroupId: draggingRef.current.sourceGroupId,
      refPayloadPresent: true, statePayloadPresent: draggingRef.current !== null, canEdit: false,
    });
    clearDragVisuals();
    draggingRef.current = null; dragPayloadForEndLog.current = null; setDragging(null); setDropTarget(null); dragoverLogged.current.clear();
  }, [sourceGeneration, dispatch, dragging]);
  useEffect(() => () => { sendRequest.current?.controller.abort(); clearDragVisuals(); draggingRef.current = null; dragPayloadForEndLog.current = null; dragoverLogged.current.clear(); }, []);
  const source = (draft.sourceGroups ?? []).filter(group => !draft.completedSourceIds.has(group.id));
  const unknown = Object.values(draft.writeResults).some(result => result.status === 'unknown');
  const plan = ready ? buildStackWritePlan(draft.groups, source) : { operations: [], unchanged: [] };
  const createCount = plan.operations.filter(op => op.type === 'create').length;
  const updateCount = plan.operations.filter(op => op.type === 'update').length;
  const deleteCount = plan.operations.filter(op => op.type === 'delete').length;
  const oversized = plan.operations.length > 500 || plan.operations.some(op => (op.memberIds?.length ?? 0) > 1000);
  const canSend = ready && !sending && !confirmRedetect && !unknown && !oversized && (draft.groups.length > 0 || source.some(group => group.origin === 'immich'));
  const startSend = async () => {
    if (!canSend || sendRequest.current) return;
    dispatch({ type: 'clearUndo' });
    setConfirmSend(false); setSending(true); setSendStatus('sending');
    const controller = new AbortController();
    const request = { controller, generation: currentGeneration.current };
    sendRequest.current = request;
    let results: StackWriteResult[];
    try { results = await sendStackWritePlan(plan.operations, controller.signal); }
    catch { results = plan.operations.map(op => ({ operationId: op.operationId, status: 'unknown' })); }
    if (controller.signal.aborted || sendRequest.current !== request || currentGeneration.current !== request.generation) return;
    // Unchanged local completion waits for the same generation check as remote results.
    dispatch({ type: 'writeResults', plan, results });
    setSendStatus(results.some(result => result.status === 'unknown') ? 'sendUnknown'
      : results.some(result => result.status !== 'success') ? 'sendFailure' : plan.operations.length ? 'sendSuccess' : 'sendNoChanges');
    sendRequest.current = null; setSending(false);
  };
  const selectedUnmatched = draft.unmatched.filter(asset => selectedIds.has(asset.id));
  const canEdit = ready && !confirmRedetect && !confirmSend && !sending;
  const canAdd = canEdit && draft.groups.some(group => group.id === addTargetStackId && !isSingletonImmichStack(group)) && selectedUnmatched.length > 0;
  const displayed = ready || (redetecting && draft.sourceGroups !== null) ? draft : integration.source;
  const payloadFrom = (transfer: DataTransfer) => {
    const payload = readStackDragPayload(transfer);
    if (payload) return payload;
    // Chrome can hide custom data during dragover; the ref is synchronous while React state awaits rendering.
    try { return isStackDrag(transfer) && transfer.getData(STACK_DRAG_TYPE) === '' ? draggingRef.current : null; }
    catch { return null; }
  };
  const observeTransfer = (transfer: DataTransfer) => {
    let dataTransferTypes: string[] = [];
    let filesLength = 0;
    let typesReadable = true;
    try { dataTransferTypes = Array.from(transfer.types).slice(0, 16).map(type => String(type).slice(0, 128)); }
    catch { typesReadable = false; }
    try { filesLength = transfer.files.length; } catch { /* Keep a safe unknown-like count when the browser denies access. */ }
    const hasCustomMime = typesReadable && dataTransferTypes.some(type => type.toLowerCase() === STACK_DRAG_TYPE);
    let customDataState: 'nonempty' | 'empty' | 'unreadable' = 'unreadable';
    let observedPayload: StackDragPayload | null = null;
    let payloadSource: 'data-transfer' | 'active-ref' | 'none' = 'none';
    if (filesLength === 0 && hasCustomMime) {
      try {
        const raw = transfer.getData(STACK_DRAG_TYPE);
        customDataState = raw ? 'nonempty' : 'empty';
        if (raw) { observedPayload = parseStackDragPayload(raw); if (observedPayload) payloadSource = 'data-transfer'; }
        else if (draggingRef.current) { observedPayload = draggingRef.current; payloadSource = 'active-ref'; }
      } catch { customDataState = 'unreadable'; }
    } else if (typesReadable) customDataState = 'empty';
    return { dataTransferTypes, filesLength, hasCustomMime, customDataState, payloadSource, observedPayload };
  };
  const logDragover = (event: React.DragEvent, target: DndTarget, accepted: boolean, rejectionReason: string | null,
    payload: StackDragPayload | null = null) => {
    if (frontendLogger.getLevel() !== 'debug') return;
    const observed = observeTransfer(event.dataTransfer);
    const actualPayload = payload ?? observed.observedPayload;
    const context = {
      assetId: actualPayload?.assetId ?? null, sourceGroupId: actualPayload?.sourceGroupId ?? null,
      targetGroupId: target.targetGroupId, ...(target.targetAssetId ? { targetAssetId: target.targetAssetId } : {}),
      targetKind: target.targetKind, ...observed, observedPayload: undefined,
      refPayloadPresent: draggingRef.current !== null, statePayloadPresent: dragging !== null,
      canEdit, accepted, rejectionReason,
    };
    const { observedPayload: _ignored, ...safeContext } = context;
    const targetKey = `${target.targetKind}:${target.targetGroupId ?? ''}:${target.targetAssetId ?? ''}`;
    const stateKey = JSON.stringify([accepted, rejectionReason, observed.dataTransferTypes, observed.filesLength,
      observed.hasCustomMime, observed.customDataState, observed.payloadSource, draggingRef.current !== null,
      dragging !== null, canEdit]);
    if (dragoverLogged.current.get(targetKey) === stateKey) return;
    if (!dragoverLogged.current.has(targetKey) && dragoverLogged.current.size >= 100) return;
    dragoverLogged.current.set(targetKey, stateKey);
    logStackDnd(accepted ? 'dragover.accepted' : 'dragover.rejected', safeContext);
  };
  const rejectionReason = (transfer: DataTransfer, payload: StackDragPayload | null, validTarget: boolean, targetGroupId: string | null = null) => {
    if (!canEdit) return 'not-editable';
    if (transfer.files.length > 0) return 'external-file';
    if (!isStackDrag(transfer)) return 'not-stack-drag';
    if (!payload) {
      try { return transfer.getData(STACK_DRAG_TYPE) ? 'malformed-payload' : 'no-payload'; }
      catch { return 'getdata-unreadable'; }
    }
    if (payload.sourceGroupId && draft.groups.some(group => group.id === payload.sourceGroupId && isSingletonImmichStack(group))) return 'singleton-source';
    if (targetGroupId && draft.groups.some(group => group.id === targetGroupId && isSingletonImmichStack(group))) return 'singleton-target';
    return validTarget ? null : 'invalid-target';
  };
  const handleDragOver = (event: React.DragEvent, target: DndTarget, targetGroupId: string | null) => {
    const accepted = target.targetKind === 'unmatched-photo'
      ? canAcceptUnmatchedPhotoDrop(event, target.targetAssetId!)
      : canAcceptDrop(event, targetGroupId);
    if (frontendLogger.getLevel() === 'debug') {
      const payload = payloadFrom(event.dataTransfer);
      logDragover(event, target, accepted, rejectionReason(event.dataTransfer, payload, accepted, targetGroupId), payload);
    }
    return accepted;
  };
  const logDrop = (event: React.DragEvent, target: DndTarget, accepted: boolean, payload: StackDragPayload | null,
    reason: string | null, operationKind?: string) => {
    const observed = observeTransfer(event.dataTransfer);
    const { observedPayload: _ignored, ...safeObserved } = observed;
    logStackDnd(accepted ? 'drop.accepted' : 'drop.rejected', {
      assetId: payload?.assetId ?? null, sourceGroupId: payload?.sourceGroupId ?? null,
      targetGroupId: target.targetGroupId, ...(target.targetAssetId ? { targetAssetId: target.targetAssetId } : {}),
      targetKind: target.targetKind, ...safeObserved, refPayloadPresent: draggingRef.current !== null,
      statePayloadPresent: dragging !== null, canEdit, accepted, rejectionReason: reason,
      ...(operationKind ? { operationKind } : {}),
    });
  };
  const handleDragStart = (event: React.DragEvent, payload: StackDragPayload) => {
    if (!canEdit || event.dataTransfer.files.length) {
      event.preventDefault();
      clearDragVisuals();
      if (frontendLogger.getLevel() === 'debug') {
        const { observedPayload: _ignored, ...observed } = observeTransfer(event.dataTransfer);
        logStackDnd('dragstart.rejected', { assetId: payload.assetId, sourceGroupId: payload.sourceGroupId,
          ...observed, refPayloadPresent: draggingRef.current !== null,
          statePayloadPresent: dragging !== null, canEdit,
          accepted: false, rejectionReason: !canEdit ? 'not-editable' : 'external-file' });
      }
      return false;
    }
    try {
      event.dataTransfer.setData(STACK_DRAG_TYPE, JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'move';
    } catch {
      event.preventDefault();
      clearDragVisuals();
      if (frontendLogger.getLevel() === 'debug') {
        const { observedPayload: _ignored, ...observed } = observeTransfer(event.dataTransfer);
        logStackDnd('dragstart.rejected', { assetId: payload.assetId, sourceGroupId: payload.sourceGroupId,
          ...observed, refPayloadPresent: draggingRef.current !== null,
          statePayloadPresent: dragging !== null, canEdit, accepted: false, rejectionReason: 'setdata-failed' });
      }
      return false;
    }
    let nativeGhostSuppressed = false;
    try {
      // Keep browser-owned drag feedback transparent; the photo preview is rendered separately as normal DOM.
      const nativeImage = document.createElement('div');
      nativeImage.className = 'stack-native-drag-image';
      document.body.appendChild(nativeImage);
      nativeDragImageRef.current = nativeImage;
      event.dataTransfer.setDragImage(nativeImage, 0, 0);
      nativeGhostSuppressed = true;
    } catch {
      removeDragElement(nativeDragImageRef.current);
      nativeDragImageRef.current = null;
    }
    let customPreviewCreated = false;
    try {
      const sourceImage = event.currentTarget.querySelector<HTMLImageElement>('.stack-thumbnail img');
      if (!sourceImage) throw new Error('Stack thumbnail image unavailable');
      const rect = sourceImage.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const pointerX = Number.isFinite(event.clientX) ? event.clientX : rect.left;
      const pointerY = Number.isFinite(event.clientY) ? event.clientY : rect.top;
      const rawGrabX = pointerX - rect.left;
      const rawGrabY = pointerY - rect.top;
      dragPreviewGrabOffsetRef.current = {
        x: Math.min(width, Math.max(0, Number.isFinite(rawGrabX) ? rawGrabX : 0)),
        y: Math.min(height, Math.max(0, Number.isFinite(rawGrabY) ? rawGrabY : 0)),
      };
      const preview = sourceImage.cloneNode(false) as HTMLImageElement;
      preview.removeAttribute('class');
      preview.removeAttribute('style');
      preview.draggable = false;
      preview.loading = 'eager';
      preview.className = 'stack-drag-preview';
      Object.assign(preview.style, { width: `${width}px`, height: `${height}px`, objectFit: 'contain', opacity: '0.88', filter: 'none', boxShadow: 'none', border: '0' });
      document.body.appendChild(preview);
      dragPreviewRef.current = preview;
      moveDragPreview(pointerX, pointerY);
      customPreviewCreated = true;
    } catch {
      removeDragElement(dragPreviewRef.current);
      dragPreviewRef.current = null;
    }
    draggingRef.current = payload;
    dragPayloadForEndLog.current = payload;
    setDragging(payload);
    dragoverLogged.current.clear();
    if (frontendLogger.getLevel() === 'debug') {
      const { observedPayload: _ignored, ...observed } = observeTransfer(event.dataTransfer);
      logStackDnd('dragstart', { assetId: payload.assetId, sourceGroupId: payload.sourceGroupId,
        ...observed, refPayloadPresent: true, statePayloadPresent: dragging !== null,
        canEdit, accepted: true, rejectionReason: null, customPreviewCreated, nativeGhostSuppressed });
    }
    return true;
  };
  const clearDrag = () => { clearDragVisuals(); draggingRef.current = null; setDragging(null); setDropTarget(null); dragoverLogged.current.clear(); };
  const handleDragEnd = () => {
    const payload = draggingRef.current ?? dragPayloadForEndLog.current;
    if (frontendLogger.getLevel() === 'debug') logStackDnd('dragend', { assetId: payload?.assetId ?? null, sourceGroupId: payload?.sourceGroupId ?? null,
      refPayloadPresent: draggingRef.current !== null, statePayloadPresent: dragging !== null, canEdit, accepted: true, rejectionReason: null });
    clearDrag();
    dragPayloadForEndLog.current = null;
  };
  const canAcceptDrop = (event: React.DragEvent, targetId: string | null) => {
    if (!canEdit || !isStackDrag(event.dataTransfer)) return false;
    const payload = payloadFrom(event.dataTransfer);
    return payload !== null && canDropStackPayload(payload, targetId, draft.groups, draft.unmatched);
  };
  const canAcceptUnmatchedPhotoDrop = (event: React.DragEvent, targetAssetId: string) => {
    if (!canEdit || !isStackDrag(event.dataTransfer)) return false;
    const payload = payloadFrom(event.dataTransfer);
    return payload !== null && canCreateStackFromUnmatchedDrop(payload, targetAssetId, draft.groups, draft.unmatched);
  };
  const acceptDrop = (event: React.DragEvent, targetId: string | null) => {
    const accepted = canAcceptDrop(event, targetId);
    const target: DndTarget = targetId === null
      ? { targetKind: 'unmatched-area', targetGroupId: null }
      : { targetKind: 'stack', targetGroupId: targetId };
    if (!accepted) {
      if (frontendLogger.getLevel() === 'debug') {
        const payload = payloadFrom(event.dataTransfer);
        logDrop(event, target, false, payload, rejectionReason(event.dataTransfer, payload, false, targetId));
      }
      return;
    }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const acceptedPayload = payloadFrom(event.dataTransfer)!;
    if (frontendLogger.getLevel() === 'debug') logDrop(event, target, true, acceptedPayload, null,
      acceptedPayload.sourceGroupId === null ? 'unmatched-to-stack' : targetId === null ? 'stack-to-unmatched' : 'stack-to-stack');
    if (targetId === null) dispatch({ type: 'purgeMember', groupId: acceptedPayload.sourceGroupId!, assetId: acceptedPayload.assetId });
    else if (acceptedPayload.sourceGroupId === null) dispatch({ type: 'dropUnmatched', assetId: acceptedPayload.assetId, targetGroupId: targetId });
    else dispatch({ type: 'moveMember', assetId: acceptedPayload.assetId, sourceGroupId: acceptedPayload.sourceGroupId, targetGroupId: targetId });
    clearDrag();
  };
  const addSelected = useCallback((targetGroupId?: string) => {
    if (canEdit && (targetGroupId ? selectedUnmatched.length > 0 : canAdd)) dispatch({ type: 'add', targetGroupId });
  }, [canEdit, canAdd, selectedUnmatched.length]);
  const runRedetect = () => {
    setSendStatus(null);
    setRedetecting(true);
    // Resolving a fresh membership list also supplies fresh auto-detection inputs.
    immich.retry(true);
  };
  const redetect = () => {
    if (busy || sending || confirmSend || (!ready && !immich.error)) return;
    if (draft.modified) setConfirmRedetect(true);
    else runRedetect();
  };
  const continueRedetect = () => {
    setConfirmRedetect(false);
    runRedetect();
  };
  const { homeThumbnailColumns } = useAppSettings();
  const { contentRef, effectiveColumns } = useStackColumns(homeThumbnailColumns);
  const { isOpen: settingsOpen } = useSettingsDialog();
  const shortcut = useShortcutDisplay();
  useEffect(() => { if (ready && redetecting) setRedetecting(false); }, [ready, redetecting]);
  const returnHome = useCallback(() => {
    navigate('/', { state: navigation?.homeReturn ? { homeReturn: navigation.homeReturn } : null });
  }, [navigate, navigation?.homeReturn]);

  useEffect(() => {
    const original = document.title;
    document.title = `${t('stackManagement.title')} - GenzoRoom`;
    return () => { document.title = original; };
  }, [t]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (settingsOpen || event.defaultPrevented || event.isComposing || event.repeat
        || isNativeEditingTarget(event.target)
        || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], details.edit-settings-menu[open]')
        || confirmRedetect || confirmSend) return;
      if (matchesShortcut(event, 'workspaceReturnHome')) { event.preventDefault(); returnHome(); }
      else if (matchesShortcut(event, 'undo') && canEdit && draft.undoSnapshot) { event.preventDefault(); dispatch({ type: 'undo' }); }
      else if (matchesShortcut(event, 'stackAddSelected') && canAdd) { event.preventDefault(); addSelected(); }
      // Escape dismisses local page selection and Add targeting rather than an application command.
      else if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault(); dispatch({ type: 'clear' });
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settingsOpen, returnHome, confirmRedetect, confirmSend, canAdd, addSelected, canEdit, draft.undoSnapshot]);

  return <main className="stack-management-page" style={{ '--stack-columns': homeThumbnailColumns, '--stack-effective-columns': effectiveColumns } as CSSProperties}
    onDragOverCapture={event => moveDragPreview(event.clientX, event.clientY)}>
    <header className="stack-management-header">
      <HomeTitle className="stack-home-title" onActivate={returnHome} />
      <h1>{t('stackManagement.title')}</h1>
      <div className="stack-header-actions">
        <button type="button" onClick={returnHome} title={shortcut.title(t('stackManagement.backHome'), 'workspaceReturnHome')}>{t('stackManagement.backHome')}</button>
        <SettingsButton />
      </div>
    </header>
    <div className="stack-control-bar" role="region" aria-label={t('stackManagement.actions')}>
      <div className="stack-control-actions">
        <strong aria-live="polite">{t('stackManagement.selectionCount', { count: selectedIds.size })}</strong>
        <button type="button" disabled={!canEdit || !selectedIds.size} onClick={() => dispatch({ type: 'clearSelection' })}>{t('photos.clearSelection')}</button>
        <button type="button" disabled={!canAdd} onClick={() => addSelected()} title={shortcut.title(t('stackManagement.add'), 'stackAddSelected')}>{t('stackManagement.add')}</button>
        <button type="button" disabled={!canEdit || selectedUnmatched.length < 2} onClick={() => dispatch({ type: 'create' })}>{t('stackManagement.newStack')}</button>
      </div>
      {plan.operations.length > 0 && <span className="stack-pending-summary" role="status">
        {t('stackManagement.pendingSummary', { create: createCount, update: updateCount, delete: deleteCount })}
      </span>}
      <div className="stack-control-actions">
        <HomeThumbnailSizeControl />
        <button type="button" disabled={busy || sending || confirmSend || (!ready && !immich.error) || confirmRedetect || !assets.length} aria-busy={busy} onClick={redetect}>{t('stackManagement.detect')}</button>
        <button type="button" disabled={!canSend || confirmSend} aria-busy={sending} onClick={() => setConfirmSend(true)}>{t('stackManagement.send')}</button>
      </div>
    </div>
    <div ref={contentRef} className="stack-content" aria-busy={busy || sending}>
      {oversized && <p className="stack-status" role="status">{t('stackManagement.sendLimit')}</p>}
      {immich.loading && <p className="stack-status" role="status">{t('stackManagement.loadingImmich')}</p>}
      {immich.error && <p className="stack-status" role="alert">{t('stackManagement.immichFailure')}</p>}
      {detection.loading && <p className="stack-status" role="status">{t('stackManagement.detecting')}</p>}
      {detection.failureCount > 0 && <p className="stack-status" role="status">{t(detection.failureCount === detection.detailCount ? 'stackManagement.allFailure' : 'stackManagement.partialFailure')}</p>}
      <section aria-labelledby="stack-candidates-heading">
        <div className="stack-section-heading">
          <h2 id="stack-candidates-heading">{t('stackManagement.candidates')}</h2>
          {sendStatus && <span className={`stack-send-status${sendStatus === 'sendFailure' || sendStatus === 'sendUnknown' ? ' stack-send-status-error' : ''}`} role="status">{t(`stackManagement.${sendStatus}`)}</span>}
        </div>
        <div className="stack-candidate-grid">{displayed.groups.length ? displayed.groups.map((group, index) => <section data-stack-id={group.id}
          key={group.id} className={`stack-candidate-group${isSingletonImmichStack(group) ? ' stack-singleton-warning' : ''}${addTargetStackId === group.id ? ' stack-add-target' : ''}${dropTarget === group.id ? ' stack-drop-target' : ''}`} aria-label={t('stackManagement.group', { index: index + 1 })}
          onDragOver={event => {
            if (event.target instanceof Element && event.target.closest('.stack-group-indicators')) {
              if (frontendLogger.getLevel() === 'debug') logDragover(event, { targetKind: 'stack', targetGroupId: group.id }, false, 'non-interactive-indicator');
              return;
            }
            if (handleDragOver(event, { targetKind: 'stack', targetGroupId: group.id }, group.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(group.id); }
          }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && dropTarget === group.id) setDropTarget(null); }}
          onDrop={event => {
            if (event.target instanceof Element && event.target.closest('.stack-group-indicators')) {
              if (frontendLogger.getLevel() === 'debug') logDrop(event, { targetKind: 'stack', targetGroupId: group.id }, false,
                payloadFrom(event.dataTransfer), 'non-interactive-indicator');
              return;
            }
            acceptDrop(event, group.id);
          }}
          style={{ '--stack-member-count': group.members.length } as CSSProperties}>
          <header className="stack-group-header">
            <button type="button" className="stack-icon-button stack-purge-group" disabled={!canEdit}
              title={t('stackManagement.purgeGroup')} aria-label={t('stackManagement.purgeGroup')}
              onClick={() => dispatch({ type: 'purgeGroup', groupId: group.id })}>×</button>
            <StackEvidenceHeader group={group} result={draft.writeResults[group.id]} />
            {!isSingletonImmichStack(group) && <button type="button" className="stack-icon-button stack-set-target" disabled={!canEdit} aria-pressed={addTargetStackId === group.id}
              title={t('stackManagement.addTarget')} aria-label={t('stackManagement.addTarget')}
              onClick={() => selectedUnmatched.length
                ? addSelected(group.id)
                : dispatch({ type: 'target', groupId: group.id })}>+</button>}
            {addTargetStackId === group.id && <span className="visually-hidden">{t('stackManagement.addTarget')}</span>}
          </header>
          <div className="stack-group-members">{group.members.map(asset => <StackPhoto key={asset.id} asset={asset}
            selected={false} member cover={asset.id === group.coverAssetId} disabled={!canEdit || isSingletonImmichStack(group)}
            dragging={dragging?.assetId === asset.id && dragging.sourceGroupId === group.id}
            onDragStart={event => handleDragStart(event, { assetId: asset.id, sourceGroupId: group.id })} onDragEnd={handleDragEnd}
            onToggle={() => dispatch({ type: 'cover', groupId: group.id, assetId: asset.id })}
            onPurge={isSingletonImmichStack(group) ? undefined : () => dispatch({ type: 'purgeMember', groupId: group.id, assetId: asset.id })} />)}</div>
        </section>) : <p className="stack-empty">{t('stackManagement.noCandidates')}</p>}</div>
      </section>
      <section aria-labelledby="stack-unmatched-heading" className={`${displayed.unmatched.length ? '' : 'stack-unmatched-empty'}${dropTarget === 'unmatched' ? ' stack-unmatched-drop-target' : ''}`}
        onDragOver={event => { if (handleDragOver(event, { targetKind: 'unmatched-area', targetGroupId: null }, null)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget('unmatched'); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && dropTarget === 'unmatched') setDropTarget(null); }}
        onDrop={event => acceptDrop(event, null)}>
        <h2 id="stack-unmatched-heading">{t('stackManagement.unmatched')}</h2>
        {displayed.unmatched.length ? <div className="stack-unmatched-grid">{displayed.unmatched.map(asset => <StackPhoto
          key={asset.id} asset={asset} selected={selectedIds.has(asset.id)} disabled={!canEdit}
          dropTarget={dropTarget === `unmatched:${asset.id}`}
          onDropTargetDragOver={event => {
            if (!handleDragOver(event, { targetKind: 'unmatched-photo', targetGroupId: null, targetAssetId: asset.id }, null)) return;
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(`unmatched:${asset.id}`);
          }}
          onDropTargetDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node) && dropTarget === `unmatched:${asset.id}`) setDropTarget(null);
          }}
          onDropTargetDrop={event => {
            const accepted = canAcceptUnmatchedPhotoDrop(event, asset.id);
            if (!accepted) return;
            const payload = payloadFrom(event.dataTransfer)!;
            if (frontendLogger.getLevel() === 'debug') logDrop(event,
              { targetKind: 'unmatched-photo', targetGroupId: null, targetAssetId: asset.id }, true, payload, null, 'unmatched-to-unmatched');
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
            dispatch({ type: 'createFromUnmatchedDrop', draggedAssetId: payload.assetId, targetAssetId: asset.id });
            clearDrag();
          }}
          dragging={dragging?.assetId === asset.id && dragging.sourceGroupId === null}
          onDragStart={event => handleDragStart(event, { assetId: asset.id, sourceGroupId: null })} onDragEnd={handleDragEnd}
          onToggle={() => dispatch({ type: 'select', assetId: asset.id })} />)}</div>
          : <p className="stack-empty">{t(assets.length ? 'stackManagement.noUnmatched' : 'stackManagement.empty')}</p>}
      </section>
    </div>
    {confirmRedetect && <StackRedetectDialog onConfirm={continueRedetect} onCancel={() => setConfirmRedetect(false)} />}
    {confirmSend && <StackRedetectDialog title={t('stackManagement.send')} body={t('stackManagement.sendConfirm', {
      create: createCount, update: updateCount, delete: deleteCount,
    })} onConfirm={() => { void startSend(); }} onCancel={() => setConfirmSend(false)} />}
  </main>;
}

function StackEvidenceHeader({ group, result }: { group: DraftStack; result?: StackWriteResult }) {
  const { t } = useTranslation();
  const labels = [['name', 'NAME'], ['time', 'TIME'], ['camera', 'CAM'], ['gps', 'GPS']] as const;
  if (isSingletonImmichStack(group)) {
    const failure = result && result.status !== 'success'
      ? t(result.status === 'unknown' ? 'stackManagement.sendUnknown' : result.status === 'blocked' ? 'stackManagement.sendBlocked' : 'stackManagement.sendFailure') : null;
    const description = [t('stackManagement.immichSingleton'), failure].filter(Boolean).join(' — ');
    return <div className="stack-group-indicators"><span className="stack-evidence singleton-warning" title={description}><span aria-hidden="true">IMMICH</span><span className="visually-hidden">{description}</span></span></div>;
  }
  if (result && result.status !== 'success') {
    const description = t(result.status === 'unknown' ? 'stackManagement.sendUnknown' : result.status === 'blocked' ? 'stackManagement.sendBlocked' : 'stackManagement.sendFailure');
    return <div className="stack-group-indicators"><span className="stack-evidence error" title={description}><span aria-hidden="true">{group.origin === 'immich' ? 'IMMICH' : group.origin === 'manual' || group.modified ? 'MANUAL' : 'STACK'}</span><span className="visually-hidden">{description}</span></span></div>;
  }
  if (group.origin === 'immich') {
    const description = t(group.modified ? 'stackManagement.immichModified' : 'stackManagement.immichUnchanged');
    return <div className="stack-group-indicators"><span className={`stack-evidence ${group.modified ? 'mismatch' : 'matched'}`} title={description}><span aria-hidden="true">IMMICH</span><span className="visually-hidden">{description}</span></span></div>;
  }
  if (group.origin === 'manual' || group.modified) return <div className="stack-group-indicators"><span className="stack-evidence mismatch" title={t('stackManagement.manual')}>MANUAL</span></div>;
  return <div className="stack-group-indicators">{labels.map(([key, label]) => {
    const state = group.evidence[key];
    const nameReasonKey = group.evidence.nameReason === 'exact' ? 'nameExact'
      : group.evidence.nameReason === 'pixel-normalized' ? 'namePixel' : 'nameMismatch';
    const detail = key === 'name' ? t(`stackManagement.${nameReasonKey}`) : t(`stackManagement.${state}`);
    return <span key={key} className={`stack-evidence ${state}`} title={`${label}: ${t(`stackManagement.${state}`)}${key === 'name' ? ` — ${detail}` : ''}`}><span aria-hidden="true">{label}</span><span className="visually-hidden">{label}: {t(`stackManagement.${state}`)}</span></span>;
  })}</div>;
}

function StackPhoto({ asset, selected, cover = false, member = false, disabled = false, dragging = false, dropTarget = false,
  onDragStart, onDragEnd, onToggle, onPurge, onDropTargetDragOver, onDropTargetDragLeave, onDropTargetDrop }: {
  asset: RecentAsset; selected: boolean; cover?: boolean; member?: boolean; disabled?: boolean;
  dragging?: boolean; dropTarget?: boolean; onDragStart: (event: React.DragEvent<HTMLButtonElement>) => boolean; onDragEnd: () => void;
  onToggle: () => void; onPurge?: () => void;
  onDropTargetDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropTargetDragLeave?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropTargetDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const suppressClick = useRef(false);
  return <div className="stack-photo-wrapper" onDragOver={onDropTargetDragOver} onDragLeave={onDropTargetDragLeave} onDrop={onDropTargetDrop}><button disabled={disabled} draggable={!disabled} className={`stack-photo${cover ? ' stack-cover' : ''}${selected && !member ? ' stack-selection-active' : ''}${dragging ? ' stack-photo-dragging' : ''}${dropTarget ? ' stack-drop-target' : ''}`} type="button" aria-pressed={member ? cover : selected}
    aria-label={t(member ? cover ? 'stackManagement.currentCover' : 'stackManagement.setCover' : selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename })}
    aria-description={cover ? t('stackManagement.cover') : undefined}
    onDragStart={event => { suppressClick.current = onDragStart(event); }}
    onDragEnd={() => { onDragEnd(); window.setTimeout(() => { suppressClick.current = false; }, 0); }}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onToggle(); }}>
    <div className="stack-thumbnail">{/* Keep the custom Stack payload on the parent instead of starting a native image drag. */}<img src={asset.thumbnail_url} alt="" loading="lazy" draggable={false} /><FormatBadge format={asset.format} isRaw={asset.is_raw} />
      {cover && <span className="stack-cover-badge" title={t('stackManagement.cover')}>COVER</span>}
    </div>
    <span className="stack-filename" title={asset.filename}>{asset.filename}</span>
  </button>{onPurge && <button className="stack-icon-button stack-purge-member" type="button" disabled={disabled}
    title={t('stackManagement.purgeMember', { filename: asset.filename })} aria-label={t('stackManagement.purgeMember', { filename: asset.filename })}
    onClick={event => { event.stopPropagation(); onPurge(); }}>×</button>}</div>;
}
