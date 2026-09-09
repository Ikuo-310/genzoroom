import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoCard, type RecentAsset } from './PhotoCard';

beforeEach(async () => i18n.changeLanguage('en'));

function renderBadge(format: string, isRaw: boolean, filename = `photo.${format.toLowerCase()}`) {
  const asset: RecentAsset = {
    id: 'asset-id',
    filename,
    date: '2026-09-08T20:43:43',
    thumbnail_url: '/api/assets/asset-id/thumbnail',
    format,
    is_raw: isRaw,
  };
  return renderToStaticMarkup(<PhotoCard asset={asset} language="en" onOpen={vi.fn()} onToggleSelection={vi.fn()} />);
}

describe('PhotoCard format badge', () => {
  it.each([
    ['JPEG', false],
    ['HEIC', false],
    ['DNG', true],
  ] as const)('renders the %s badge', (format, isRaw) => {
    const markup = renderBadge(format, isRaw);

    expect(markup).toContain(`>${format}</span>`);
    expect(markup).toContain(isRaw ? 'format-badge raw' : 'class="format-badge"');
  });

  it('keeps a long filename in the separate metadata area', () => {
    const filename = `${'very-long-photo-name-'.repeat(8)}.jpeg`;
    const markup = renderBadge('JPEG', false, filename);

    expect(markup).toContain('class="thumbnail"');
    expect(markup).toContain('class="photo-info"');
    expect(markup).toContain(`title="${filename}"`);
  });

  it('renders a keyboard-operable selection checkbox without changing normal card navigation', () => {
    const markup = renderBadge('JPEG', false, 'photo.jpg');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('class="photo-selection-input"');
    expect(markup).toContain('aria-label="Select photo.jpg"');
    expect(markup).toContain('aria-label="Open photo.jpg in Anshitsu"');
  });

  it('marks a selected card and changes the card action while selection mode is active', () => {
    const selectedAsset: RecentAsset = {
      id: 'selected-id', filename: 'selected.dng', date: '2026-09-08T20:43:43',
      thumbnail_url: '/thumbnail', format: 'DNG', is_raw: true,
    };
    const markup = renderToStaticMarkup(<PhotoCard
      asset={selectedAsset}
      language="en"
      selected
      selectionMode
      onOpen={vi.fn()}
      onToggleSelection={vi.fn()}
    />);
    expect(markup).toContain('photo-card selected selection-mode');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Deselect selected.dng');
  });
});
