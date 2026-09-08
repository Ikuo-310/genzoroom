import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoFilterControls } from './PhotoFilterControls';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('PhotoFilterControls', () => {
  it('renders the English labels with both filters selected initially', () => {
    const markup = renderToStaticMarkup(
      <PhotoFilterControls
        filters={{ raw: true, nonRaw: true }}
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain('RAW');
    expect(markup).toContain('Non-RAW');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(markup).not.toContain('disabled=""');
  });

  it('renders the Japanese label', async () => {
    await i18n.changeLanguage('ja');

    const markup = renderToStaticMarkup(
      <PhotoFilterControls
        filters={{ raw: true, nonRaw: true }}
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain('RAW以外');
  });

  it('disables the last selected checkbox', () => {
    const markup = renderToStaticMarkup(
      <PhotoFilterControls
        filters={{ raw: true, nonRaw: false }}
        onToggle={vi.fn()}
      />,
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });
});
