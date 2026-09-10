import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchAssetDetail, isRecentAsset } from './api';
import type { AssetDetail, AssetExif, RecentAsset, WorkspaceNavigationState } from './assets';
import { FormatBadge } from './FormatBadge';
import { LanguageControl } from './GalleryPage';
import { ImageViewer } from './ImageViewer';
import { formatPhotoDate, type AppLanguage } from './i18n';
import { activateWorkspaceAsset, workspacePath } from './photoSelection';
import { AdjustmentSlider } from './AdjustmentSlider';
import { CONTRAST, EXPOSURE, HIGHLIGHTS, formatContrast, formatExposure, formatHighlights, supportsEditing, type EditEntry } from './editing';
import { getEditImageSource } from './editImageSource';
import { useAssetEdits } from './useAssetEdits';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { clampResizedSidebar, fitSidebarWidths, readSidebarWidths, saveSidebarWidths, type SidebarSide } from './sidebarSizing';

type DetailState = 'loading' | 'ready' | 'error';

export function AnshitsuPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { assetId = '' } = useParams();
  const language: AppLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const initialNavigation = useMemo(() => readNavigationState(location.state), [location.state]);
  // selectedAssets already uses an array even though this phase opens one item at a time.
  const [selectedAssets, setSelectedAssets] = useState<RecentAsset[]>(initialNavigation?.selectedAssets ?? []);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('loading');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const activeDetail = detail?.id === assetId ? detail : null;
  const editable = !!activeDetail && supportsEditing(activeDetail);
  const { session, dispatch } = useAssetEdits(assetId, editable);

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

  const summary = detail ? detailToRecent(detail) : selectedAssets.find((asset) => asset.id === assetId);
  return <main className="workspace-page">
    <header className="workspace-header">
      <div className="workspace-brand">
        <strong>GenzoRoom</strong>
        <span>{t('workspace.name')}</span>
        {language === 'en' && <small>{t('workspace.subtitle')}</small>}
      </div>
      <div className="workspace-asset-title">
        <span title={summary?.filename}>{summary?.filename ?? t('workspace.loading')}</span>
        {summary && <time dateTime={summary.date}>{formatPhotoDate(summary.date, language)}</time>}
      </div>
      <div className="workspace-actions">
        <button type="button" className="tool-button" onClick={() => navigate('/')}>{t('workspace.backToPhotos')}</button>
        <LanguageControl language={language} compact />
      </div>
    </header>

    <WorkspaceLayout
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      leftPanel={<>
        <WorkspaceSection title={t('workspace.history')}>
          <div className="edit-actions">
            <button className="tool-button" disabled={!editable || (session.cursor === 0 && !session.pending)} onClick={() => dispatch({ type: 'undo' })}>{t('workspace.undo')}</button>
            <button className="tool-button" disabled={!editable || session.cursor >= session.history.length || !!session.pending} onClick={() => dispatch({ type: 'redo' })}>{t('workspace.redo')}</button>
          </div>
          {session.history.length === 0 ? <p>{t('workspace.historyEmpty')}</p>
            : <EditHistory history={session.history} cursor={session.cursor} />}
        </WorkspaceSection>
        <WorkspaceSection title="EXIF" grow>
          {detail ? <ExifDetails exif={detail.exif} fallbackDate={detail.date} language={language} />
            : <p>{detailState === 'error' ? t('workspace.detailFailed') : t('workspace.loading')}</p>}
        </WorkspaceSection>
      </>}
      viewer={detailState === 'ready' && activeDetail ? (
        <ImageViewer
          key={assetId}
          src={activeDetail.preview_url}
          editSource={editable ? getEditImageSource(activeDetail) : undefined}
          recipe={editable ? session.recipe : undefined}
          alt={activeDetail.filename}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => setLeftOpen((value) => !value)}
          onToggleRight={() => setRightOpen((value) => !value)}
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
        <WorkspaceSection title={t('workspace.scope')} className="scope-section">
          <p>{t('workspace.scopePlaceholder')}</p>
        </WorkspaceSection>
        <WorkspaceSection title={t('workspace.developControls')} grow headerAction={editable
          ? <button type="button" className="tool-button workspace-section-action" onClick={() => dispatch({ type: 'allReset' })}>{t('workspace.allReset')}</button>
          : undefined}>
          {editable ? <>
            <AdjustmentSlider key={assetId} label={t('workspace.exposure')} value={session.recipe.adjustments.exposure}
              {...EXPOSURE} valueText={`${formatExposure(session.recipe.adjustments.exposure)} EV`}
              valueLabel={t('workspace.exposureValue')} unit="EV" precision={2} defaultValue={0}
              resetLabel={t('workspace.exposureReset')}
              onBegin={() => dispatch({ type: 'begin', kind: 'exposure' })}
              onChange={(value) => dispatch({ type: 'exposure', value })}
              onCommit={() => dispatch({ type: 'commit', kind: 'exposure' })}
              onReset={() => dispatch({ type: 'exposureReset' })} />
            <AdjustmentSlider key={`${assetId}-contrast`} label={t('workspace.contrast')} value={session.recipe.adjustments.contrast}
              {...CONTRAST} valueText={formatContrast(session.recipe.adjustments.contrast)}
              valueLabel={t('workspace.contrastValue')} precision={0} defaultValue={0}
              resetLabel={t('workspace.contrastReset')}
              onBegin={() => dispatch({ type: 'begin', kind: 'contrast' })}
              onChange={(value) => dispatch({ type: 'contrast', value })}
              onCommit={() => dispatch({ type: 'commit', kind: 'contrast' })}
              onReset={() => dispatch({ type: 'contrastReset' })} />
            <AdjustmentSlider key={`${assetId}-highlights`} label={t('workspace.highlights')} value={session.recipe.adjustments.highlights}
              {...HIGHLIGHTS} valueText={formatHighlights(session.recipe.adjustments.highlights)}
              valueLabel={t('workspace.highlightsValue')} precision={0} defaultValue={0}
              resetLabel={t('workspace.highlightsReset')}
              onBegin={() => dispatch({ type: 'begin', kind: 'highlights' })}
              onChange={(value) => dispatch({ type: 'highlights', value })}
              onCommit={() => dispatch({ type: 'commit', kind: 'highlights' })}
              onReset={() => dispatch({ type: 'highlightsReset' })} />
            <p>{t('workspace.exposureHelp')}</p>
            <p>{t('workspace.contrastHelp')}</p>
            <p>{t('workspace.highlightsHelp')}</p>
            <p className="edit-source-note">{t('workspace.previewEditingNote')}</p>
          </> : <p>{t('workspace.jpegOnly')}</p>}
        </WorkspaceSection>
      </>}
    />

    <Filmstrip
      assets={selectedAssets}
      activeAssetId={assetId}
      onActivate={(nextId) => {
        const currentState: WorkspaceNavigationState = { selectedAssets, activeAssetId: assetId };
        const nextState = activateWorkspaceAsset(currentState, nextId);
        navigate(workspacePath(nextState.activeAssetId), { state: nextState });
      }}
    />
  </main>;
}

type WorkspaceLayoutProps = {
  leftOpen: boolean;
  rightOpen: boolean;
  leftPanel: ReactNode;
  viewer: ReactNode;
  rightPanel: ReactNode;
};

export function WorkspaceLayout({ leftOpen, rightOpen, leftPanel, viewer, rightPanel }: WorkspaceLayoutProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState(readSidebarWidths);
  const widthsRef = useRef(widths);
  const [containerWidth, setContainerWidth] = useState(0);
  const layoutClass = `workspace-body${leftOpen ? ' left-open' : ''}${rightOpen ? ' right-open' : ''}`;
  const fitted = fitSidebarWidths(widths, containerWidth, leftOpen, rightOpen);
  const style = {
    '--left-panel-width': `${fitted.left}px`,
    '--right-panel-width': `${fitted.right}px`,
  } as CSSProperties;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const updateWidth = () => setContainerWidth(body.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  function resize(side: SidebarSide, proposedWidth: number) {
    const bodyWidth = bodyRef.current?.clientWidth ?? containerWidth;
    const current = fitSidebarWidths(widthsRef.current, bodyWidth, leftOpen, rightOpen);
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherOpen = side === 'left' ? rightOpen : leftOpen;
    const width = clampResizedSidebar(side, proposedWidth, bodyWidth, current[otherSide], otherOpen);
    const next = { ...widthsRef.current, [side]: width };
    widthsRef.current = next;
    setWidths(next);
  }

  return <div ref={bodyRef} className={layoutClass} style={style}>
    <aside className="workspace-side-panel left-panel" hidden={!leftOpen}>{leftPanel}</aside>
    <SidebarResizeHandle side="left" width={fitted.left} label={t('workspace.resizeLeftPanel')}
      hidden={!leftOpen} onResize={resize} onResizeEnd={() => saveSidebarWidths(widthsRef.current)} />
    {viewer}
    <SidebarResizeHandle side="right" width={fitted.right} label={t('workspace.resizeRightPanel')}
      hidden={!rightOpen} onResize={resize} onResizeEnd={() => saveSidebarWidths(widthsRef.current)} />
    <aside className="workspace-side-panel right-panel" hidden={!rightOpen}>{rightPanel}</aside>
  </div>;
}

export function WorkspaceSection({ title, children, grow = false, className = '', headerAction }: { title: string; children: ReactNode; grow?: boolean; className?: string; headerAction?: ReactNode }) {
  const sectionClassName = `workspace-section${grow ? ' grow' : ''}${className ? ` ${className}` : ''}`;

  return <section className={sectionClassName}>
    <div className="workspace-section-header">
      <h2>{title}</h2>
      {headerAction}
    </div>
    <div className="workspace-section-content">{children}</div>
  </section>;
}

export function EditHistory({ history, cursor }: { history: readonly EditEntry[]; cursor: number }) {
  const { t } = useTranslation();
  const newestFirst = history.map((entry, index) => ({ entry, index })).reverse();

  return <ol className="edit-history">
    {newestFirst.map(({ entry, index }) => {
      const isContrast = entry.kind === 'contrast' || entry.kind === 'contrastReset';
      const isHighlights = entry.kind === 'highlights' || entry.kind === 'highlightsReset';
      const before = isContrast ? formatContrast(entry.before.adjustments.contrast)
        : isHighlights ? formatHighlights(entry.before.adjustments.highlights) : formatExposure(entry.before.adjustments.exposure);
      const after = isContrast ? formatContrast(entry.after.adjustments.contrast)
        : isHighlights ? formatHighlights(entry.after.adjustments.highlights) : formatExposure(entry.after.adjustments.exposure);
      return <li key={index} value={index + 1} className={index >= cursor ? 'undone' : undefined}
        aria-current={index === cursor - 1 ? 'step' : undefined}>
        {t(`workspace.${entry.kind}`)} {entry.kind === 'allReset' && <>{t('workspace.exposure')} </>}{before} → {after}
        {entry.kind === 'allReset' && <>; {t('workspace.contrast')} {formatContrast(entry.before.adjustments.contrast)} → {formatContrast(entry.after.adjustments.contrast)}</>}
        {entry.kind === 'allReset' && <>; {t('workspace.highlights')} {formatHighlights(entry.before.adjustments.highlights)} → {formatHighlights(entry.after.adjustments.highlights)}</>}
        {index >= cursor && <span> ({t('workspace.undone')})</span>}
      </li>;
    })}
  </ol>;
}

export function ExifDetails({ exif, fallbackDate, language }: { exif: AssetExif; fallbackDate: string; language: AppLanguage }) {
  const { t } = useTranslation();
  const rows: Array<[string, string | number | undefined]> = [
    [t('workspace.exif.date'), formatPhotoDate(exif.date_time_original ?? fallbackDate, language)],
    [t('workspace.exif.make'), exif.make],
    [t('workspace.exif.model'), exif.model],
    [t('workspace.exif.lens'), exif.lens_model],
    [t('workspace.exif.focalLength'), exif.focal_length === undefined ? undefined : `${exif.focal_length} mm`],
    [t('workspace.exif.aperture'), exif.f_number === undefined ? undefined : `f/${exif.f_number}`],
    [t('workspace.exif.shutterSpeed'), exif.exposure_time],
    ['ISO', exif.iso],
    [t('workspace.exif.exposureCompensation'), exif.exposure_compensation === undefined ? undefined : `${exif.exposure_compensation > 0 ? '+' : ''}${exif.exposure_compensation} EV`],
    [t('workspace.exif.dimensions'), exif.width !== undefined && exif.height !== undefined ? `${exif.width} × ${exif.height}` : undefined],
  ];
  const visibleRows = rows.filter((row): row is [string, string | number] => row[1] !== undefined && row[1] !== '');
  return visibleRows.length > 0 ? <dl className="exif-list">{visibleRows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl> : <p>{t('workspace.exif.empty')}</p>;
}

export function Filmstrip({ assets, activeAssetId, onActivate }: { assets: RecentAsset[]; activeAssetId: string; onActivate: (id: string) => void }) {
  const { t } = useTranslation();
  return <section className="filmstrip" aria-label={t('workspace.filmstrip')}>
    <div className="filmstrip-scroll">
      {assets.map((asset) => <button
        key={asset.id}
        type="button"
        className={`filmstrip-item${asset.id === activeAssetId ? ' active' : ''}`}
        onClick={() => onActivate(asset.id)}
        aria-current={asset.id === activeAssetId ? 'true' : undefined}
        aria-label={asset.filename}
      >
        <img src={asset.thumbnail_url} alt="" />
        <FormatBadge format={asset.format} isRaw={asset.is_raw} />
      </button>)}
    </div>
  </section>;
}

function readNavigationState(value: unknown): WorkspaceNavigationState | null {
  if (typeof value !== 'object' || value === null || !('selectedAssets' in value) || !('activeAssetId' in value)) return null;
  const state = value as { selectedAssets: unknown; activeAssetId: unknown };
  if (!Array.isArray(state.selectedAssets) || !state.selectedAssets.every(isRecentAsset) || typeof state.activeAssetId !== 'string') return null;
  return { selectedAssets: state.selectedAssets, activeAssetId: state.activeAssetId };
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
