import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoSelectionBar } from './PhotoSelectionBar';

afterEach(async () => i18n.changeLanguage('en'));
beforeEach(async () => i18n.changeLanguage('en'));

describe('PhotoSelectionBar', () => {
  it('shows the total selection count and English actions', () => {
    const markup = renderToStaticMarkup(<PhotoSelectionBar count={3} onClear={vi.fn()} onOpen={vi.fn()} />);
    expect(markup).toContain('3 selected');
    expect(markup).toContain('Clear selection');
    expect(markup).toContain('Open in Anshitsu');
  });

  it('shows natural Japanese actions', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<PhotoSelectionBar count={2} onClear={vi.fn()} onOpen={vi.fn()} />);
    expect(markup).toContain('2枚選択中');
    expect(markup).toContain('選択解除');
    expect(markup).toContain('暗室へ');
  });
});
