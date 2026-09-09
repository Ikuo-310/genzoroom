import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoSelectionBar } from './PhotoSelectionBar';

afterEach(async () => i18n.changeLanguage('en'));
beforeEach(async () => i18n.changeLanguage('en'));

describe('PhotoSelectionBar', () => {
  it('shows the total selection count and English actions', () => {
    const markup = renderToStaticMarkup(<PhotoSelectionBar active count={3} onClear={vi.fn()} onOpen={vi.fn()} />);
    expect(markup).toContain('3 selected');
    expect(markup).toContain('Clear selection');
    expect(markup).toContain('Open in Anshitsu');
  });

  it('keeps the same selection-bar region reserved while selection is inactive', () => {
    const inactive = renderToStaticMarkup(<PhotoSelectionBar active={false} count={0} onClear={vi.fn()} onOpen={vi.fn()} />);
    const active = renderToStaticMarkup(<PhotoSelectionBar active count={1} onClear={vi.fn()} onOpen={vi.fn()} />);

    expect(inactive).toContain('selection-bar inactive');
    expect(inactive).toContain('aria-hidden="true"');
    expect(inactive).toContain('disabled=""');
    expect(active).toContain('selection-bar active');
    expect(active).not.toContain('aria-hidden="true"');
  });

  it('shows natural Japanese actions', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<PhotoSelectionBar active count={2} onClear={vi.fn()} onOpen={vi.fn()} />);
    expect(markup).toContain('2枚選択中');
    expect(markup).toContain('選択解除');
    expect(markup).toContain('暗室へ');
  });
});
