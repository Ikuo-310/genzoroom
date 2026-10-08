// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { EditStatusFilterControls } from './EditStatusFilterControls';

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('EditStatusFilterControls', () => {
  it('renders the English label and edit status choices', () => {
    const markup = renderToStaticMarkup(<EditStatusFilterControls mode="both" onChange={vi.fn()} />);
    expect(markup).toContain('Edit status');
    expect(markup).toContain('<option value="both" selected="">All</option>');
    expect(markup).toContain('<option value="edited">Edited</option>');
    expect(markup).toContain('<option value="unedited">Not edited</option>');
    const container = document.createElement('div'); container.innerHTML = markup;
    expect(container.querySelector('.home-select-sizing option')?.textContent).toBe('All');
    expect(container.querySelector<HTMLLabelElement>('label.home-control-label')?.control).toBe(container.querySelector('.home-select-interactive'));
  });

  it('renders the Japanese label and choices', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<EditStatusFilterControls mode="edited" onChange={vi.fn()} />);
    expect(markup).toContain('補正');
    expect(markup).toContain('<option value="both">すべて</option>');
    expect(markup).toContain('<option value="edited" selected="">補正あり</option>');
    expect(markup).toContain('<option value="unedited">補正なし</option>');
    const container = document.createElement('div'); container.innerHTML = markup;
    expect(container.querySelector('.home-select-sizing option')?.textContent).toBe('補正あり');
  });
});
