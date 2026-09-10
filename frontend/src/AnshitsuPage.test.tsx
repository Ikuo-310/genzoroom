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
const secondAsset: RecentAsset = {
  id: '87654321-4321-4321-8321-cba987654321',
  filename: 'second-photo.heic',
  date: '2026-09-09T08:15:00',
  thumbnail_url: '/api/assets/456/thumbnail',
  format: 'HEIC',
  is_raw: false,
};

afterEach(async () => i18n.changeLanguage('en'));

function renderWorkspace(
  language: 'en' | 'ja',
  selectedAssets = [asset],
  activeAssetId = asset.id,
) {
  void i18n.changeLanguage(language);
  const state: WorkspaceNavigationState = { selectedAssets, activeAssetId };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: `/anshitsu/${activeAssetId}`, state }]}>
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
    const markup = renderToStaticMarkup(<Filmstrip assets={[asset, secondAsset]} activeAssetId={secondAsset.id} onActivate={vi.fn()} />);
    expect(markup).toContain('filmstrip-item active');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('format-badge raw');
    expect(markup).toContain('>HEIC</span>');
    expect(markup.match(/filmstrip-item/g)).toHaveLength(2);
  });

  it('uses the active Filmstrip asset for the workspace filename and date', () => {
    const markup = renderWorkspace('en', [asset, secondAsset], secondAsset.id);
    expect(markup).toContain(`title="${secondAsset.filename}"`);
    expect(markup).toContain(formatPhotoDate(secondAsset.date, 'en'));
    expect(markup).toContain('aria-current="true"');
  });

  it('keeps the single-photo URL usable without navigation state', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/anshitsu/${asset.id}`]}><App /></MemoryRouter>,
    );
    expect(markup).toContain('Anshitsu');
    expect(markup).toContain('Loading photo');
  });

  it('provides Fit, 1:1, zoom, pan surface, and panel controls', () => {
    const markup = renderToStaticMarkup(<ImageViewer src="/preview" alt={asset.filename} leftOpen rightOpen onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />);
    expect(markup).toContain('Fit');
    expect(markup).toContain('1:1');
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('viewer-viewport');
    expect(markup).toContain('aria-label="Collapse left panel"');
    expect(markup).toContain('aria-label="Collapse right panel"');
    expect(markup).toContain('<span>History</span>');
  });

  it('places History and EXIF on the left and Scope above Develop controls on the right', () => {
    const markup = renderWorkspace('en');
    const leftStart = markup.indexOf('class="workspace-side-panel left-panel"');
    const viewerStart = markup.indexOf('class="viewer-panel');
    const rightStart = markup.indexOf('class="workspace-side-panel right-panel"');
    const leftPanel = markup.slice(leftStart, viewerStart);
    const rightPanel = markup.slice(rightStart);

    expect(leftStart).toBeGreaterThanOrEqual(0);
    expect(viewerStart).toBeGreaterThan(leftStart);
    expect(rightStart).toBeGreaterThan(viewerStart);
    expect(leftPanel).toContain('>History</h2>');
    expect(leftPanel).toContain('>EXIF</h2>');
    expect(leftPanel).not.toContain('>Scope</h2>');
    expect(rightPanel).toContain('>Scope</h2>');
    expect(rightPanel).toContain('>Develop controls</h2>');
    expect(rightPanel.indexOf('>Scope</h2>')).toBeLessThan(rightPanel.indexOf('>Develop controls</h2>'));
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
    expect(markup.indexOf('class="workspace-side-panel left-panel"')).toBeLessThan(markup.indexOf('data-testid="viewer"'));
    expect(markup.indexOf('data-testid="viewer"')).toBeLessThan(markup.indexOf('class="workspace-side-panel right-panel"'));
  });
});
