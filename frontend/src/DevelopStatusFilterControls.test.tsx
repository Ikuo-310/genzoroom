import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { DevelopStatusFilterControls } from './DevelopStatusFilterControls';

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('DevelopStatusFilterControls', () => {
  it('renders the English label and choices', () => {
    const markup = renderToStaticMarkup(<DevelopStatusFilterControls mode="both" onChange={vi.fn()} />);
    expect(markup).toContain('Developed');
    expect(markup).toContain('<option value="both" selected="">Both</option>');
    expect(markup).toContain('<option value="developed">Developed</option>');
    expect(markup).toContain('<option value="undeveloped">Undeveloped</option>');
    expect(markup).toContain('class="home-toolbar-select-measure" aria-hidden="true">Both</span>');
  });

  it('renders the Japanese label and choices', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<DevelopStatusFilterControls mode="undeveloped" onChange={vi.fn()} />);
    expect(markup).toContain('現像');
    expect(markup).toContain('<option value="both">両方</option>');
    expect(markup).toContain('<option value="developed">現像済み</option>');
    expect(markup).toContain('<option value="undeveloped" selected="">未現像</option>');
    expect(markup).toContain('class="home-toolbar-select-measure" aria-hidden="true">未現像</span>');
  });
});
