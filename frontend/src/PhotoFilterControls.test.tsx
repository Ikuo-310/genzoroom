import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoFilterControls } from './PhotoFilterControls';

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('PhotoFilterControls', () => {
  it('renders the English type label and all three choices with both selected', () => {
    const markup = renderToStaticMarkup(<PhotoFilterControls filters={{ raw: true, nonRaw: true }} onChange={vi.fn()} />);
    expect(markup).toContain('Type');
    expect(markup).toContain('aria-label="Type"');
    expect(markup).toContain('<option value="both" selected="">All</option>');
    expect(markup).toContain('<option value="raw">RAW only</option>');
    expect(markup).toContain('<option value="nonRaw">Non-RAW</option>');
  });

  it('renders the Japanese type label and both option', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<PhotoFilterControls filters={{ raw: true, nonRaw: true }} onChange={vi.fn()} />);
    expect(markup).toContain('種別');
    expect(markup).toContain('両方');
    expect(markup).toContain('RAWのみ');
    expect(markup).toContain('RAW以外');
  });

  it('maps existing filter states to the matching option', () => {
    const rawOnly = renderToStaticMarkup(<PhotoFilterControls filters={{ raw: true, nonRaw: false }} onChange={vi.fn()} />);
    const nonRawOnly = renderToStaticMarkup(<PhotoFilterControls filters={{ raw: false, nonRaw: true }} onChange={vi.fn()} />);
    expect(rawOnly).toContain('<option value="raw" selected="">RAW only</option>');
    expect(nonRawOnly).toContain('<option value="nonRaw" selected="">Non-RAW</option>');
  });
});
