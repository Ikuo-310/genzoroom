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

export type StackNavigationState = { selectedAssets: RecentAsset[]; homeReturn?: HomeReturnContext };

function readNavigation(value: unknown): StackNavigationState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.selectedAssets) || !state.selectedAssets.every(isRecentAsset)) return null;
  const homeReturn = readHomeReturn(state.homeReturn);
  return { selectedAssets: state.selectedAssets, ...(homeReturn ? { homeReturn } : {}) };
}

export function StackManagementPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useMemo(() => readNavigation(location.state), [location.state]);
  const assets = navigation?.selectedAssets ?? [];
  // This selection belongs to the management session, independently of Home selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const { homeThumbnailColumns } = useAppSettings();
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

  return <main className="stack-management-page" style={{ '--stack-columns': homeThumbnailColumns } as CSSProperties}>
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
        <button type="button" disabled>{t('stackManagement.detect')}</button>
        <button type="button" disabled>{t('stackManagement.send')}</button>
      </div>
    </div>
    <div className="stack-content">
      <section aria-labelledby="stack-candidates-heading">
        <h2 id="stack-candidates-heading">{t('stackManagement.candidates')}</h2>
        {/* Candidate groups will be indivisible grid children spanning their member count. */}
        <div className="stack-candidate-grid"><p className="stack-empty">{t('stackManagement.noCandidates')}</p></div>
      </section>
      <section aria-labelledby="stack-unmatched-heading">
        <h2 id="stack-unmatched-heading">{t('stackManagement.unmatched')}</h2>
        {assets.length ? <div className="stack-unmatched-grid">{assets.map(asset => <button
          key={asset.id} className="stack-photo" type="button" aria-pressed={selectedIds.has(asset.id)}
          aria-label={t(selectedIds.has(asset.id) ? 'photos.deselectPhoto' : 'photos.selectPhoto', { filename: asset.filename })}
          onClick={() => toggle(asset.id)}>
          <div className="stack-thumbnail"><img src={asset.thumbnail_url} alt="" loading="lazy" /><FormatBadge format={asset.format} isRaw={asset.is_raw} /></div>
          <span className="stack-filename" title={asset.filename}>{asset.filename}</span>
        </button>)}</div> : <p className="stack-empty">{t('stackManagement.empty')}</p>}
      </section>
    </div>
  </main>;
}
