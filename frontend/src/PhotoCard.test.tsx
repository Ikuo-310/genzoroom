// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoCard, type RecentAsset } from './PhotoCard';

beforeEach(async () => i18n.changeLanguage('en'));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const interactionAsset: RecentAsset = {
  id: 'asset-id', filename: 'photo.jpg', date: '2026-09-08', thumbnail_url: '/thumbnail', format: 'JPEG', is_raw: false,
};

function renderBadge(format: string, isRaw: boolean, filename = `photo.${format.toLowerCase()}`, edited?: boolean, stackId?: string, stackAssetCount?: number | null) {
  const asset: RecentAsset = {
    id: 'asset-id',
    filename,
    date: '2026-09-08T20:43:43',
    thumbnail_url: '/api/assets/asset-id/thumbnail',
    format,
    is_raw: isRaw,
    stackId,
    stackAssetCount,
  };
  return renderToStaticMarkup(<PhotoCard asset={asset} edited={edited} language="en" onOpen={vi.fn()} onToggleSelection={vi.fn()} />);
}

describe('PhotoCard format badge', () => {
  it.each([false, true])('isolates the sibling Queue button from navigation and selection (selection mode %s)', async selectionMode => {
    const onOpen = vi.fn(), onToggleSelection = vi.fn(), onQueueToggle = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en" edited selected={selectionMode}
      selectionMode={selectionMode} queueKnown onQueueToggle={onQueueToggle}
      onOpen={onOpen} onToggleSelection={onToggleSelection} />));
    const photo = host.querySelector<HTMLButtonElement>('.photo-card-button')!;
    const badge = host.querySelector<HTMLButtonElement>('.edited-badge')!;
    expect(photo.contains(badge)).toBe(false);
    expect(host.querySelector('button button')).toBeNull();
    expect(badge.parentElement?.previousElementSibling).toBe(photo);
    expect(badge.title).not.toContain('[Q]');
    await act(async () => badge.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(onQueueToggle).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onToggleSelection).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(selectionMode);
    expect(photo.getAttribute('aria-pressed')).toBe(selectionMode ? 'true' : null);
  });
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, false],
    [true, true, true],
  ])('routes card clicks by selection mode and Shift (%s, Shift %s)', async (selectionMode, shiftKey, extendRange) => {
    const onOpen = vi.fn(), onToggleSelection = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en" selectionMode={selectionMode}
      onOpen={onOpen} onToggleSelection={onToggleSelection} />));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey });
    await act(async () => host.querySelector<HTMLButtonElement>('.photo-card-button')!.dispatchEvent(event));
    expect(onOpen).toHaveBeenCalledTimes(selectionMode || shiftKey ? 0 : 1);
    if (shiftKey) expect(onToggleSelection).toHaveBeenCalledWith(true);
    else if (selectionMode) expect(onToggleSelection).toHaveBeenCalledOnce();
    else expect(onToggleSelection).not.toHaveBeenCalled();
  });

  it('keeps checkbox normal toggles and Shift range clicks single-shot', async () => {
    const onOpen = vi.fn(), onToggleSelection = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en" selectionMode
      onOpen={onOpen} onToggleSelection={onToggleSelection} />));
    const checkbox = host.querySelector<HTMLInputElement>('.photo-selection-input')!;
    await act(async () => checkbox.click());
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledOnce();
    onToggleSelection.mockClear();
    const shiftClick = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true });
    await act(async () => checkbox.dispatchEvent(shiftClick));
    expect(shiftClick.defaultPrevented).toBe(true);
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledWith(true);
    await act(async () => checkbox.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it.each([true, false, undefined])('shows a display-only GenzoRoom badge only for known edited status %s', edited => {
    const markup = renderBadge('JPEG', false, 'photo.jpg', edited);
    expect(markup.includes('class="edited-badge"')).toBe(edited === true);
    if (edited) expect(markup).toContain('role="img" aria-label="Edited in GenzoRoom"');
    expect(markup).toContain('class="format-badge"');
  });
  it('localizes the edited indicator in Japanese', async () => {
    await i18n.changeLanguage('ja');
    expect(renderBadge('JPEG', false, 'photo.jpg', true)).toContain('aria-description="GenzoRoomで編集済み"');
  });
  it.each([
    ['JPEG', false],
    ['HEIC', false],
    ['DNG', true],
  ] as const)('renders the %s badge', (format, isRaw) => {
    const markup = renderBadge(format, isRaw);

    expect(markup).toContain(`>${format}</span>`);
    expect(markup).toContain(isRaw ? 'format-badge raw' : 'class="format-badge"');
  });

  it.each([2, 3, 12])('shows the original format and total Stack count %s', count => {
    const markup = renderBadge('DNG', true, 'photo.dng', true, 'stack-id', count);
    expect(markup).toContain('class="format-badge raw">DNG</span>');
    expect(markup).toContain(`class="stack-asset-count">${count}</span>`);
    expect(markup).toContain(`aria-label="Stack, ${count} assets"`);
    expect(markup).not.toContain('stack-asset-count-error');
    expect(markup).toContain('class="edited-badge"');
    expect(markup).not.toContain('thumbnail stacked');
  });

  it('shows the singleton Stack as an invalid Stack warning without changing its badge structure', () => {
    const markup = renderBadge('JPEG', false, 'photo.jpg', undefined, 'stack-id', 1);
    expect(markup).toContain('<div class="stack-assets" role="img" aria-label="Invalid Stack, 1 asset"><span class="stack-asset-count stack-asset-count-error">1</span></div>');
  });

  it('shows no Stack labels for unstacked photos or missing and malformed counts', () => {
    for (const [stackId, count] of [[undefined, 2], ['stack-id', undefined], ['stack-id', null],
      ['stack-id', 0], ['stack-id', -1], ['stack-id', 2.5], ['stack-id', Number.NaN]] as const) {
      const markup = renderBadge('JPEG', false, 'photo.jpg', undefined, stackId, count);
      expect(markup).toContain('class="format-badge">JPEG</span>');
      expect(markup).not.toContain('stack-asset-count');
    }
  });

  it('localizes the Stack accessible description in Japanese', async () => {
    await i18n.changeLanguage('ja');
    expect(renderBadge('PNG', false, 'photo.png', undefined, 'stack-id', 3))
      .toContain('aria-label="Stack、3枚"');
  });

  it('localizes the invalid singleton Stack description in Japanese', async () => {
    await i18n.changeLanguage('ja');
    expect(renderBadge('JPEG', false, 'photo.jpg', undefined, 'stack-id', 1))
      .toContain('aria-label="異常STACK、1枚"');
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
    expect(markup).toContain('aria-label="Open photo.jpg for development"');
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

  it('renders a hundred-photo grid without dropping cards', () => {
    const assets = Array.from({ length: 100 }, (_, index): RecentAsset => ({
      id: `asset-${index + 1}`,
      filename: `photo-${index + 1}.jpg`,
      date: '2026-09-08T20:43:43',
      thumbnail_url: `/api/assets/asset-${index + 1}/thumbnail`,
      format: 'JPEG',
      is_raw: false,
    }));
    const markup = renderToStaticMarkup(<div className="photo-grid">{assets.map((asset) => (
      <PhotoCard key={asset.id} asset={asset} language="en" onOpen={vi.fn()} onToggleSelection={vi.fn()} />
    ))}</div>);

    expect(markup.match(/<article/g)).toHaveLength(100);
    expect(markup.match(/<img src="\/api\/assets\/asset-\d+\/thumbnail"/g)).toHaveLength(100);
    expect(markup.match(/class="format-badge"/g)).toHaveLength(100);
    expect(markup).toContain('photo-100.jpg');
  });
});
