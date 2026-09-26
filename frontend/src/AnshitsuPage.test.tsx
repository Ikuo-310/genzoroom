import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { EditHistory, ExifDetails, Filmstrip, WorkspaceLayout, WorkspaceSection } from './AnshitsuPage';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import type { EditEntry } from './editing';
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
    expect(markup).not.toContain('All Reset');
  });

  it('places All Reset beside the Develop controls heading', () => {
    const markup = renderToStaticMarkup(<WorkspaceSection title="Develop controls"
      headerAction={<button className="workspace-section-action">All Reset</button>}><p>Adjustment</p></WorkspaceSection>);
    const headerStart = markup.indexOf('class="workspace-section-header"');
    const contentStart = markup.indexOf('class="workspace-section-content"');
    const header = markup.slice(headerStart, contentStart);
    expect(header).toContain('>Develop controls</h2>');
    expect(header).toContain('>All Reset</button>');
    expect(markup.slice(contentStart)).not.toContain('All Reset');
  });

  it('renders History newest first while preserving chronological item numbers', () => {
    const history = [historyEntry(0, 0.1), historyEntry(0.1, 0.2), historyEntry(0.2, 0.3)];
    const original = [...history];
    const markup = renderToStaticMarkup(<EditHistory history={history} cursor={3} />);
    expect(markup.indexOf('value="3"')).toBeLessThan(markup.indexOf('value="2"'));
    expect(markup.indexOf('value="2"')).toBeLessThan(markup.indexOf('value="1"'));
    expect(markup).toContain('<li value="3" class="current"><button type="button" aria-current="step">Exposure +0.20 → +0.30</button></li>');
    expect(markup).toContain('>Initial State</button>');
    expect(history).toEqual(original);
  });

  it('keeps newest-first History order across Undo, Redo, and a new edit', () => {
    const history = [historyEntry(0, 0.1), historyEntry(0.1, 0.2), historyEntry(0.2, 0.3)];
    const undone = renderToStaticMarkup(<EditHistory history={history} cursor={2} />);
    expect(undone).toContain('<li value="3" class="undone"><button type="button">Exposure +0.20 → +0.30</button></li>');
    expect(undone).not.toContain('Undone');
    expect(undone).toContain('<li value="2" class="current"><button type="button" aria-current="step">Exposure +0.10 → +0.20</button></li>');
    const redone = renderToStaticMarkup(<EditHistory history={history} cursor={3} />);
    expect(redone).toContain('<li value="3" class="current"><button type="button" aria-current="step">Exposure +0.20 → +0.30</button></li>');
    const withNewEdit = renderToStaticMarkup(<EditHistory history={[...history, historyEntry(0.3, 0.4)]} cursor={4} />);
    expect(withNewEdit.indexOf('value="4"')).toBeLessThan(withNewEdit.indexOf('value="3"'));
    expect(withNewEdit).toContain('<li value="4" class="current"><button type="button" aria-current="step">Exposure +0.30 → +0.40</button></li>');
  });

  it('shows Initial State as current at cursor zero and disables every row while editing is unavailable', () => {
    const history = [historyEntry(0, 0.1), historyEntry(0.1, 0.2)];
    const markup = renderToStaticMarkup(<EditHistory history={history} cursor={0} disabled />);
    expect(markup).toContain('<li class="initial-state current"><button type="button" disabled="" aria-current="step">Initial State</button></li>');
    expect(markup.match(/<button type="button" disabled=""/g)).toHaveLength(3);
    expect(markup).toContain('<li value="2" class="undone"><button type="button" disabled="">Exposure +0.10 → +0.20</button></li>');
  });

  it('renders adjustment, category, and reset History succinctly in newest-first order', () => {
    const contrast: EditEntry = {
      kind: 'contrast',
      before: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 30, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const highlights: EditEntry = {
      kind: 'highlights',
      before: contrast.after,
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 30, highlights: -20, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const whites: EditEntry = {
      kind: 'whites',
      before: highlights.after,
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 30, highlights: -20, whites: 15, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const shadows: EditEntry = {
      kind: 'shadows',
      before: whites.after,
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 30, highlights: -20, whites: 15, shadows: 25, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const blacks: EditEntry = {
      kind: 'blacks',
      before: shadows.after,
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 30, highlights: -20, whites: 15, shadows: 25, blacks: -35, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const allReset: EditEntry = {
      kind: 'allReset',
      before: { ...blacks.after, basicEnabled: false },
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    const basicToggle: EditEntry = {
      kind: 'basicToggle',
      before: blacks.after,
      after: { ...blacks.after, basicEnabled: false },
    };
    const basicReset: EditEntry = {
      kind: 'basicReset',
      before: basicToggle.after,
      after: { version: 17, whiteBalanceEnabled: true, basicEnabled: false, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    };
    allReset.before = basicReset.after;
    const markup = renderToStaticMarkup(<EditHistory history={[historyEntry(0, 0.25), contrast, highlights, whites, shadows, blacks, basicToggle, basicReset, allReset]} cursor={9} />);
    expect(markup.indexOf('value="9"')).toBeLessThan(markup.indexOf('value="8"'));
    expect(markup).toContain('<li value="9" class="current"><button type="button" aria-current="step">All Reset</button></li>');
    expect(markup).toContain('<li value="8"><button type="button">Reset Basic adjustments</button></li>');
    expect(markup).toContain('<li value="7"><button type="button">Basic OFF</button></li>');
    expect(markup).not.toContain('All Reset Exposure');
    expect(markup).toContain('Blacks 0 → -35');
    expect(markup).toContain('Shadows 0 → +25');
    expect(markup).toContain('Whites 0 → +15');
    expect(markup).toContain('Highlights 0 → -20');
    expect(markup).toContain('Contrast 0 → +30');
  });

  it('renders Basic ON after an enable operation', () => {
    const before = { version: 17, whiteBalanceEnabled: true, basicEnabled: false, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0.25, contrast: 20, highlights: -30, whites: 10, shadows: 40, blacks: -15, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } } as const;
    const entry: EditEntry = {
      kind: 'basicToggle',
      before,
      after: { ...before, basicEnabled: true },
    };
    expect(renderToStaticMarkup(<EditHistory history={[entry]} cursor={1} />)).toContain('Basic ON');
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
    expect(markup).toContain(`class="sidebar-resize-handle left" role="separator" aria-label="Resize left panel" aria-orientation="vertical"${leftOpen ? '' : ' hidden=""'}`);
    expect(markup).toContain(`class="sidebar-resize-handle right" role="separator" aria-label="Resize right panel" aria-orientation="vertical"${rightOpen ? '' : ' hidden=""'}`);
  });
});

function historyEntry(before: number, after: number): EditEntry {
  return {
    kind: 'exposure',
    before: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: before, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
    after: { version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: after, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } },
  };
}

describe('explicit Basic History formatting', () => {
  it.each([
    ['exposure', 'Exposure', 0.25, '+0.25', '0.00'],
    ['contrast', 'Contrast', 21, '+21', '0'],
    ['highlights', 'Highlights', -32, '-32', '0'],
    ['whites', 'Whites', 43, '+43', '0'],
    ['shadows', 'Shadows', 54, '+54', '0'],
    ['blacks', 'Blacks', -65, '-65', '0'],
  ] as const)('formats %s changes and individual resets', (key, label, value, formatted, zero) => {
    const before = historyEntry(0, 0).before;
    const after = { ...before, adjustments: { ...before.adjustments, [key]: value } };
    const history: EditEntry[] = [
      { kind: key, before, after },
      { kind: `${key}Reset`, before: after, after: before },
    ];
    const markup = renderToStaticMarkup(<EditHistory history={history} cursor={2} />);
    expect(markup).toContain(`${label} ${zero} → ${formatted}`);
    expect(markup).toContain(`${label} Reset ${formatted} → ${zero}`);
  });
  it.each(['futureColor', 'futureColorReset', 'toString'])('does not render Exposure values for unknown kind %s', (kind) => {
    const entry = { ...historyEntry(1.25, 2.5), kind } as EditEntry;
    const markup = renderToStaticMarkup(<EditHistory history={[entry]} cursor={1} />);
    expect(markup).toContain(`>${kind}</button></li>`);
    expect(markup).not.toContain('Exposure');
    expect(markup).not.toContain('1.25');
    expect(markup).not.toContain('2.50');
    expect(markup).not.toContain('→');
  });
});
