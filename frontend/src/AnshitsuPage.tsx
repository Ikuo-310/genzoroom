import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchAssetDetail, isRecentAsset } from './api';
import type { AssetDetail, AssetExif, RecentAsset, WorkspaceNavigationState } from './assets';
import { FormatBadge } from './FormatBadge';
import { LanguageControl } from './GalleryPage';
import { ImageViewer } from './ImageViewer';
import { formatPhotoDate, type AppLanguage } from './i18n';

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
        <WorkspaceSection title={t('workspace.scope')}>
          <p>{t('workspace.scopePlaceholder')}</p>
        </WorkspaceSection>
        <WorkspaceSection title={t('workspace.history')}>
          <p>{t('workspace.historyPlaceholder')}</p>
        </WorkspaceSection>
        <WorkspaceSection title="EXIF" grow>
          {detail ? <ExifDetails exif={detail.exif} fallbackDate={detail.date} language={language} />
            : <p>{detailState === 'error' ? t('workspace.detailFailed') : t('workspace.loading')}</p>}
        </WorkspaceSection>
      </>}
      viewer={detailState === 'ready' && detail ? (
        <ImageViewer
          src={detail.preview_url}
          alt={detail.filename}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => setLeftOpen((value) => !value)}
          onToggleRight={() => setRightOpen((value) => !value)}
        />
      ) : (
        <section className="viewer-panel viewer-message" aria-live="polite">
          <div className="viewer-toolbar">
            <button type="button" className="tool-button panel-toggle" onClick={() => setLeftOpen((value) => !value)} aria-label={t(leftOpen ? 'workspace.collapseLeft' : 'workspace.expandLeft')}>{leftOpen ? '‹' : '›'} <span>{t('workspace.scope')}</span></button>
            <button type="button" className="tool-button panel-toggle right" onClick={() => setRightOpen((value) => !value)} aria-label={t(rightOpen ? 'workspace.collapseRight' : 'workspace.expandRight')}><span>{t('workspace.developControls')}</span> {rightOpen ? '›' : '‹'}</button>
          </div>
          <p className={detailState === 'error' ? 'error-text' : ''}>{t(detailState === 'error' ? 'workspace.detailFailed' : 'workspace.loading')}</p>
        </section>
      )}
      rightPanel={
        <WorkspaceSection title={t('workspace.developControls')} grow>
          <p>{t('workspace.controlsUnavailable')}</p>
        </WorkspaceSection>
      }
    />

    <Filmstrip
      assets={selectedAssets}
      activeAssetId={assetId}
      onActivate={(nextId) => navigate(`/anshitsu/${nextId}`, {
        state: { selectedAssets, activeAssetId: nextId } satisfies WorkspaceNavigationState,
      })}
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
  const layoutClass = `workspace-body${leftOpen ? ' left-open' : ''}${rightOpen ? ' right-open' : ''}`;
  return <div className={layoutClass}>
    <aside className="workspace-side-panel left-panel" hidden={!leftOpen}>{leftPanel}</aside>
    {viewer}
    <aside className="workspace-side-panel right-panel" hidden={!rightOpen}>{rightPanel}</aside>
  </div>;
}

function WorkspaceSection({ title, children, grow = false }: { title: string; children: ReactNode; grow?: boolean }) {
  return <section className={`workspace-section${grow ? ' grow' : ''}`}>
    <h2>{title}</h2>
    <div className="workspace-section-content">{children}</div>
  </section>;
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
