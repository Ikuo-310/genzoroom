import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoSelectionBar } from './PhotoSelectionBar';

afterEach(async () => i18n.changeLanguage('en'));
beforeEach(async () => i18n.changeLanguage('en'));

describe('PhotoSelectionBar', () => {
  it('shows the total selection count and English actions', () => {
    const markup = renderToStaticMarkup(<PhotoSelectionBar count={3} onClear={vi.fn()} onOpen={vi.fn()} onOpenStacks={vi.fn()} />);
    expect(markup).toContain('3 selected');
    expect(markup).toContain('>Clear</button>');
    expect(markup).toContain('>Stacks[S]</button>');
    expect(markup).toContain('>Develop[D]</button>');
    expect(markup).toContain('aria-label="Clear selection"');
    expect(markup).toContain('aria-label="Manage Stacks"');
    expect(markup).toContain('aria-label="Develop selected photos"');
    expect(markup).toContain('title="Clear selection"');
  });

  it('keeps zero-count controls visible and the workspace action enabled', () => {
    const inactive = renderToStaticMarkup(<PhotoSelectionBar count={0} onClear={vi.fn()} onOpen={vi.fn()} onOpenStacks={vi.fn()} />);
    const active = renderToStaticMarkup(<PhotoSelectionBar count={1} onClear={vi.fn()} onOpen={vi.fn()} onOpenStacks={vi.fn()} />);

    expect(inactive).toContain('0 selected');
    expect(inactive).not.toContain('aria-hidden');
    expect(inactive).toContain('disabled=""');
    expect(inactive.match(/<button[^>]*class="selection-open-workspace"[^>]*>/)?.[0]).not.toContain('disabled');
    for (const name of ['all', 'clear', 'open-stacks']) {
      expect(inactive.match(new RegExp(`<button[^>]*class="selection-${name}"[^>]*>`))?.[0]).toContain('disabled');
    }
    expect(active).toContain('1 selected');
    expect(active).not.toContain('aria-hidden="true"');
  });

  it('shows natural Japanese actions', async () => {
    await i18n.changeLanguage('ja');
    const markup = renderToStaticMarkup(<PhotoSelectionBar count={2} onClear={vi.fn()} onOpen={vi.fn()} onOpenStacks={vi.fn()} />);
    expect(markup).toContain('2枚選択中');
    expect(markup).toContain('選択解除');
    expect(markup).toContain('暗室へ');
    expect(markup).toContain('>STACK管理へ[S]</button>');
    expect(markup).toContain('>暗室へ[D]</button>');
    expect(markup).not.toContain('>Clear</button>');
    expect(markup).not.toContain('>Stacks</button>');
    expect(markup).not.toContain('>Develop</button>');
  });
});
