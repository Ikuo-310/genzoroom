import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ExifDetails, Filmstrip, WorkspaceLayout } from './AnshitsuPage';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { ImageViewer } from './ImageViewer';
import i18n, { formatPhotoDate } from './i18n';

const asset: RecentAsset = {
  id: '12345678-1234-4234-9234-123456789abc',
  filename: 'a-very-long-photo-filename-for-the-workspace-header.dng',
  date: '2026-09-08T20:43:43',
  thumbnail_url: '/api/assets/123/thumbnail',
  format: 'DNG',
  is_raw: true,
};

afterEach(async () => i18n.changeLanguage('en'));

function renderWorkspace(language: 'en' | 'ja') {
  void i18n.changeLanguage(language);
  const state: WorkspaceNavigationState = { selectedAssets: [asset], activeAssetId: asset.id };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: `/anshitsu/${asset.id}`, state }]}>
      <App />
    </MemoryRouter>,
  );
}

describe('Anshitsu workspace', () => {
  it('renders the English name, subtitle, selected filename, and localized date', () => {
    const markup = renderWorkspace('en');
    expect(markup).toContain('Anshitsu');
    expect(markup).toContain('Photo development workspace');
    expect(markup).toContain(`title="${asset.filename}"`);
    expect(markup).toContain(formatPhotoDate(asset.date, 'en'));
  });

  it('renders the Japanese name without the English-only subtitle', () => {
    const markup = renderWorkspace('ja');
    expect(markup).toContain('暗室');
    expect(markup).not.toContain('Photo development workspace');
    expect(markup).toContain(formatPhotoDate(asset.date, 'ja'));
  });

  it('omits missing EXIF values instead of rendering undefined or null', () => {
    const markup = renderToStaticMarkup(<ExifDetails exif={{}} fallbackDate={asset.date} language="en" />);
    expect(markup).not.toContain('undefined');
    expect(markup).not.toContain('null');
    expect(markup).toContain('Captured');
  });

  it('marks the active Filmstrip thumbnail and keeps the format badge', () => {
    const markup = renderToStaticMarkup(<Filmstrip assets={[asset]} activeAssetId={asset.id} onActivate={vi.fn()} />);
    expect(markup).toContain('filmstrip-item active');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('format-badge raw');
  });

  it('provides Fit, 100%, zoom, pan surface, and panel controls', () => {
    const markup = renderToStaticMarkup(<ImageViewer src="/preview" alt={asset.filename} leftOpen rightOpen onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />);
    expect(markup).toContain('Fit');
    expect(markup).toContain('100%');
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('viewer-viewport');
    expect(markup).toContain('aria-label="Collapse left panel"');
    expect(markup).toContain('aria-label="Collapse right panel"');
  });

  it.each([
    { leftOpen: true, rightOpen: true, expectedClass: 'workspace-body left-open right-open' },
    { leftOpen: false, rightOpen: true, expectedClass: 'workspace-body right-open' },
    { leftOpen: true, rightOpen: false, expectedClass: 'workspace-body left-open' },
    { leftOpen: false, rightOpen: false, expectedClass: 'workspace-body' },
  ])('keeps the Viewer rendered with left=$leftOpen and right=$rightOpen', ({ leftOpen, rightOpen, expectedClass }) => {
    const markup = renderToStaticMarkup(
      <WorkspaceLayout
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        leftPanel={<p>Left panel</p>}
        viewer={<section className="viewer-panel" data-testid="viewer">Viewer</section>}
        rightPanel={<p>Right panel</p>}
      />,
    );

    expect(markup).toContain(`class="${expectedClass}"`);
    expect(markup).toContain('data-testid="viewer"');
    expect(markup.match(/data-testid="viewer"/g)).toHaveLength(1);
  });
});
