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
  const detection = useStackCandidateDetection(assets);
  // This selection belongs to the management session, independently of Home selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
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
        || !matchesShortcut(event, 'workspaceReturnHome')) return;
      event.preventDefault();
      returnHome();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [settingsOpen, returnHome]);

  function toggle(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

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
        <button type="button" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>{t('photos.clearSelection')}</button>
        <button type="button" disabled>{t('stackManagement.add')}</button>
      </div>
      <div className="stack-control-actions">
        <HomeThumbnailSizeControl />
        <button type="button" disabled={detection.loading || !assets.length} aria-busy={detection.loading} onClick={detection.redetect}>{t('stackManagement.detect')}</button>
        <button type="button" disabled>{t('stackManagement.send')}</button>
      </div>
    </div>
    <div ref={contentRef} className="stack-content" aria-busy={detection.loading}>
      {detection.loading && <p className="stack-status" role="status">{t('stackManagement.detecting')}</p>}
      {detection.failureCount > 0 && <p className="stack-status" role="status">{t(detection.failureCount === detection.detailCount ? 'stackManagement.allFailure' : 'stackManagement.partialFailure')}</p>}
      <section aria-labelledby="stack-candidates-heading">
        <h2 id="stack-candidates-heading">{t('stackManagement.candidates')}</h2>
        <div className="stack-candidate-grid">{detection.groups.length ? detection.groups.map((group, index) => <section
          key={group.id} className="stack-candidate-group" aria-label={t('stackManagement.group', { index: index + 1 })}
          style={{ '--stack-member-count': group.members.length } as CSSProperties}>
          <StackEvidenceHeader group={group} />
          <div className="stack-group-members">{group.members.map(asset => <StackPhoto key={asset.id} asset={asset}
            selected={selectedIds.has(asset.id)} cover={asset.id === group.coverAssetId} onToggle={() => toggle(asset.id)} />)}</div>
        </section>) : <p className="stack-empty">{t('stackManagement.noCandidates')}</p>}</div>
      </section>
      <section aria-labelledby="stack-unmatched-heading">
        <h2 id="stack-unmatched-heading">{t('stackManagement.unmatched')}</h2>
        {detection.unmatched.length ? <div className="stack-unmatched-grid">{detection.unmatched.map(asset => <StackPhoto
          key={asset.id} asset={asset} selected={selectedIds.has(asset.id)} onToggle={() => toggle(asset.id)} />)}</div>
          : <p className="stack-empty">{t(assets.length ? 'stackManagement.noUnmatched' : 'stackManagement.empty')}</p>}
      </section>
    </div>
  </main>;
}

function StackEvidenceHeader({ group }: { group: DraftStack }) {
  const { t } = useTranslation();
  const labels = [['name', 'NAME'], ['time', 'TIME'], ['camera', 'CAM'], ['gps', 'GPS']] as const;
  return <header className="stack-group-header">{labels.map(([key, label]) => {
    const state = group.evidence[key];
    const detail = key === 'name' ? t(group.evidence.nameReason === 'exact' ? 'stackManagement.nameExact' : 'stackManagement.namePixel') : t(`stackManagement.${state}`);
    return <span key={key} className={`stack-evidence ${state}`} title={`${label}: ${t(`stackManagement.${state}`)}${key === 'name' ? ` — ${detail}` : ''}`}><span aria-hidden="true">{label}</span><span className="visually-hidden">{label}: {t(`stackManagement.${state}`)}</span></span>;
  })}</header>;
}

function StackPhoto({ asset, selected, cover = false, onToggle }: {
  asset: RecentAsset; selected: boolean; cover?: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  return <button className={`stack-photo${cover ? ' stack-cover' : ''}`} type="button" aria-pressed={selected}
    aria-label={t(selected ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename })}
    aria-description={cover ? t('stackManagement.cover') : undefined} onClick={onToggle}>
    <div className="stack-thumbnail"><img src={asset.thumbnail_url} alt="" loading="lazy" /><FormatBadge format={asset.format} isRaw={asset.is_raw} />
      {cover && <span className="stack-cover-badge" title={t('stackManagement.cover')}>COVER</span>}
    </div>
    <span className="stack-filename" title={asset.filename}>{asset.filename}</span>
  </button>;
}
