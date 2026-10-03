import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import { mergeImmichStackSource } from './immichStackDraft';
import { StackRedetectDialog } from './StackRedetectDialog';
import type { DraftStack } from './stackCandidateDetection';

const EMPTY_ASSETS: RecentAsset[] = [];

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
  const assets = navigation?.selectedAssets ?? EMPTY_ASSETS;
  const immich = useSelectedImmichStacks(assets);
  const detectionAssets = useMemo(() => {
    if (immich.loading || immich.error) return EMPTY_ASSETS;
    const memberIds = new Set(immich.stacks.flatMap(stack => stack.assets.map(asset => asset.id.toLowerCase())));
    return assets.filter(asset => asset.stackId == null && !memberIds.has(asset.id.toLowerCase()));
  }, [assets, immich.stacks, immich.loading, immich.error]);
  const detection = useStackCandidateDetection(detectionAssets);
  const integration = useMemo(() => mergeImmichStackSource(detection, immich.stacks, assets), [detection.groups, detection.unmatched, immich.stacks, assets]);
  const busy = detection.loading || immich.loading;
  const { draft, dispatch, ready } = useEditableStackDraft(integration.source, busy || immich.error, integration.assets);
  const { selectedIds, addTargetStackId } = draft;
  const [confirmRedetect, setConfirmRedetect] = useState(false);
  const selectedUnmatched = draft.unmatched.filter(asset => selectedIds.has(asset.id));
  const canEdit = ready && !confirmRedetect;
  const canAdd = canEdit && addTargetStackId !== null && selectedUnmatched.length > 0;
  const displayed = ready ? draft : integration.source;
  const addSelected = useCallback((targetGroupId?: string) => {
    if (canEdit && (targetGroupId ? selectedUnmatched.length > 0 : canAdd)) dispatch({ type: 'add', targetGroupId });
  }, [canEdit, canAdd, selectedUnmatched.length]);
  const runRedetect = () => {
    dispatch({ type: 'reset' });
    // Resolving a fresh membership list also supplies fresh auto-detection inputs.
    if (assets.some(asset => asset.stackId != null)) immich.retry();
    else detection.redetect();
  };
  const redetect = () => {
    if (busy || (!ready && !immich.error)) return;
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
        || confirmRedetect) return;
      if (matchesShortcut(event, 'workspaceReturnHome')) { event.preventDefault(); returnHome(); }
      else if (matchesShortcut(event, 'stackAddSelected') && canAdd) { event.preventDefault(); addSelected(); }
      // Escape dismisses local page selection and Add targeting rather than an application command.
      else if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault(); dispatch({ type: 'clear' });
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settingsOpen, returnHome, confirmRedetect, canAdd, addSelected]);

  return <main className="stack-management-page" style={{ '--stack-columns': homeThumbnailColumns, '--stack-effective-columns': effectiveColumns } as CSSProperties}>
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
      <div className="stack-control-actions">
        <HomeThumbnailSizeControl />
        <button type="button" disabled={busy || (!ready && !immich.error) || confirmRedetect || !assets.length} aria-busy={busy} onClick={redetect}>{t('stackManagement.detect')}</button>
        <button type="button" disabled>{t('stackManagement.send')}</button>
      </div>
    </div>
    <div ref={contentRef} className="stack-content" aria-busy={busy}>
      {immich.loading && <p className="stack-status" role="status">{t('stackManagement.loadingImmich')}</p>}
      {immich.error && <p className="stack-status" role="alert">{t('stackManagement.immichFailure')}</p>}
      {detection.loading && <p className="stack-status" role="status">{t('stackManagement.detecting')}</p>}
      {detection.failureCount > 0 && <p className="stack-status" role="status">{t(detection.failureCount === detection.detailCount ? 'stackManagement.allFailure' : 'stackManagement.partialFailure')}</p>}
      <section aria-labelledby="stack-candidates-heading">
        <h2 id="stack-candidates-heading">{t('stackManagement.candidates')}</h2>
        <div className="stack-candidate-grid">{displayed.groups.length ? displayed.groups.map((group, index) => <section
          key={group.id} className={`stack-candidate-group${addTargetStackId === group.id ? ' stack-add-target' : ''}`} aria-label={t('stackManagement.group', { index: index + 1 })}
          style={{ '--stack-member-count': group.members.length } as CSSProperties}>
          <header className="stack-group-header">
            <button type="button" className="stack-icon-button stack-purge-group" disabled={!canEdit}
              title={t('stackManagement.purgeGroup')} aria-label={t('stackManagement.purgeGroup')}
              onClick={() => dispatch({ type: 'purgeGroup', groupId: group.id })}>×</button>
            <StackEvidenceHeader group={group} />
            <button type="button" className="stack-icon-button stack-set-target" disabled={!canEdit} aria-pressed={addTargetStackId === group.id}
              title={t('stackManagement.addTarget')} aria-label={t('stackManagement.addTarget')}
              onClick={() => selectedUnmatched.length
                ? addSelected(group.id)
                : dispatch({ type: 'target', groupId: group.id })}>+</button>
            {addTargetStackId === group.id && <span className="visually-hidden">{t('stackManagement.addTarget')}</span>}
          </header>
          <div className="stack-group-members">{group.members.map(asset => <StackPhoto key={asset.id} asset={asset}
            selected={false} member cover={asset.id === group.coverAssetId} disabled={!canEdit}
            onToggle={() => dispatch({ type: 'cover', groupId: group.id, assetId: asset.id })}
            onPurge={() => dispatch({ type: 'purgeMember', groupId: group.id, assetId: asset.id })} />)}</div>
        </section>) : <p className="stack-empty">{t('stackManagement.noCandidates')}</p>}</div>
      </section>
      <section aria-labelledby="stack-unmatched-heading">
        <h2 id="stack-unmatched-heading">{t('stackManagement.unmatched')}</h2>
        {displayed.unmatched.length ? <div className="stack-unmatched-grid">{displayed.unmatched.map(asset => <StackPhoto
          key={asset.id} asset={asset} selected={selectedIds.has(asset.id)} disabled={!canEdit} onToggle={() => dispatch({ type: 'select', assetId: asset.id })} />)}</div>
          : <p className="stack-empty">{t(assets.length ? 'stackManagement.noUnmatched' : 'stackManagement.empty')}</p>}
      </section>
    </div>
    {confirmRedetect && <StackRedetectDialog onConfirm={continueRedetect} onCancel={() => setConfirmRedetect(false)} />}
  </main>;
}

function StackEvidenceHeader({ group }: { group: DraftStack }) {
  const { t } = useTranslation();
  const labels = [['name', 'NAME'], ['time', 'TIME'], ['camera', 'CAM'], ['gps', 'GPS']] as const;
  if (group.origin === 'immich') {
    const description = t(group.modified ? 'stackManagement.immichModified' : 'stackManagement.immichUnchanged');
    return <div className="stack-group-indicators"><span className={`stack-evidence ${group.modified ? 'mismatch' : 'matched'}`} title={description}><span aria-hidden="true">IMMICH</span><span className="visually-hidden">{description}</span></span></div>;
  }
  if (group.origin === 'manual' || group.modified) return <div className="stack-group-indicators"><span className="stack-evidence unavailable" title={t('stackManagement.manual')}>MANUAL</span></div>;
  return <div className="stack-group-indicators">{labels.map(([key, label]) => {
    const state = group.evidence[key];
    const nameReasonKey = group.evidence.nameReason === 'exact' ? 'nameExact'
      : group.evidence.nameReason === 'pixel-normalized' ? 'namePixel' : 'nameMismatch';
    const detail = key === 'name' ? t(`stackManagement.${nameReasonKey}`) : t(`stackManagement.${state}`);
    return <span key={key} className={`stack-evidence ${state}`} title={`${label}: ${t(`stackManagement.${state}`)}${key === 'name' ? ` — ${detail}` : ''}`}><span aria-hidden="true">{label}</span><span className="visually-hidden">{label}: {t(`stackManagement.${state}`)}</span></span>;
  })}</div>;
}

function StackPhoto({ asset, selected, cover = false, member = false, disabled = false, onToggle, onPurge }: {
  asset: RecentAsset; selected: boolean; cover?: boolean; member?: boolean; disabled?: boolean;
  onToggle: () => void; onPurge?: () => void;
}) {
  const { t } = useTranslation();
  return <div className="stack-photo-wrapper"><button disabled={disabled} className={`stack-photo${cover ? ' stack-cover' : ''}${selected && !member ? ' stack-selection-active' : ''}`} type="button" aria-pressed={member ? cover : selected}
    aria-label={t(member ? cover ? 'stackManagement.currentCover' : 'stackManagement.setCover' : selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename })}
    aria-description={cover ? t('stackManagement.cover') : undefined} onClick={onToggle}>
    <div className="stack-thumbnail"><img src={asset.thumbnail_url} alt="" loading="lazy" /><FormatBadge format={asset.format} isRaw={asset.is_raw} />
      {cover && <span className="stack-cover-badge" title={t('stackManagement.cover')}>COVER</span>}
    </div>
    <span className="stack-filename" title={asset.filename}>{asset.filename}</span>
  </button>{onPurge && <button className="stack-icon-button stack-purge-member" type="button" disabled={disabled}
    title={t('stackManagement.purgeMember', { filename: asset.filename })} aria-label={t('stackManagement.purgeMember', { filename: asset.filename })}
    onClick={event => { event.stopPropagation(); onPurge(); }}>×</button>}</div>;
}
