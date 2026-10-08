// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { PhotoCard, type RecentAsset } from './PhotoCard';
import { makeGalleryStack } from './gallerySelectionTestHelpers';
import { acceptGalleryStackSnapshots, beginGalleryStackSnapshotRequest, finishGalleryStackSnapshotRequest,
  getManualGalleryStackSelection, restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection } from './useGalleryStackSelections';
import { updateSetting } from './appSettings';

beforeEach(async () => i18n.changeLanguage('en'));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear(); restoreGalleryStackSelectionsFromSession();
  updateSetting('anshitsuInitialSelection', 'nonRaw');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const interactionAsset: RecentAsset = {
  id: 'asset-id', filename: 'photo.jpg', date: '2026-09-08', thumbnail_url: '/thumbnail', format: 'JPEG', is_raw: false,
};

function renderBadge(format: string, isRaw: boolean, filename = `photo.${format.toLowerCase()}`, edited?: boolean, stackId?: string, stackAssetCount?: number | null,
  stackFormats?: RecentAsset['stackFormats']) {
  const asset: RecentAsset = {
    id: 'asset-id',
    filename,
    date: '2026-09-08T20:43:43',
    thumbnail_url: '/api/assets/asset-id/thumbnail',
    format,
    is_raw: isRaw,
    stackId,
    stackAssetCount,
    stackFormats,
  };
  return renderToStaticMarkup(<PhotoCard asset={asset} edited={edited} language="en" onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} />);
}

describe('PhotoCard format badge', () => {
  it('reconciles saved selection when a pending request ends without changing the visible snapshot', async () => {
    const original = makeGalleryStack(1, ['JPEG', 'JPEG']);
    acceptGalleryStackSnapshots([original], beginGalleryStackSnapshotRequest());
    setManualGalleryStackSelection(original, new Set([original.stackMembers![1].id]));
    const removalRequest = beginGalleryStackSnapshotRequest();
    const pending = beginGalleryStackSnapshotRequest();
    acceptGalleryStackSnapshots([makeGalleryStack(1, ['JPEG'])], removalRequest);
    await act(async () => root.render(<PhotoCard asset={original} language="en"
      onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} />));
    expect([...getManualGalleryStackSelection(original.stackId!)!]).toEqual([original.stackMembers![1].id]);
    await act(async () => finishGalleryStackSnapshotRequest(pending));
    expect([...getManualGalleryStackSelection(original.stackId!)!]).toEqual([]);
    expect(host.querySelector('.stack-format-switch')!.getAttribute('aria-pressed')).toBe('false');
  });

  async function mountStack(asset: RecentAsset, callbacks = {}) {
    await act(async () => root.render(<PhotoCard asset={asset} language="en"
      onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} {...callbacks} />));
  }
  function switches() { return [...host.querySelectorAll<HTMLButtonElement>('.stack-format-switch')]; }

  it.each([
    [['JPEG', 'JPEG', 'DNG'], ['true', 'false']],
    [['DNG', 'DNG'], ['true']],
    [['JPEG', 'PNG', 'DNG'], ['true', 'true', 'false']],
  ])('derives initial states from actual selections for %s', async (formats, expected) => {
    const stack = makeGalleryStack(1, formats);
    stack.stackFormats = formats.map(format => ({ format, isRaw: format === 'DNG' }));
    await mountStack(stack);
    expect(switches().map(button => button.getAttribute('aria-pressed'))).toEqual(expected);
    expect(switches().every(button => !button.disabled)).toBe(true);
    expect(host.querySelector('button button')).toBeNull();
  });

  it('toggles whole formats, preserves others and persists empty manual intent without selecting cards or Queue', async () => {
    const stack = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG', 'PNG']);
    stack.stackFormats = [{ format: 'PNG', isRaw: false }, { format: 'DNG', isRaw: true }, { format: 'JPEG', isRaw: false }];
    setManualGalleryStackSelection(stack, new Set([stack.id, stack.stackMembers![3].id]));
    const callbacks = { onSelect: vi.fn(), onToggleSelection: vi.fn(), onExtendSelection: vi.fn(), onPreviewRequest: vi.fn(), onQueueToggle: vi.fn() };
    await mountStack(stack, callbacks);
    expect(switches().map(button => button.textContent)).toEqual(['JPEG', 'PNG', 'DNG']);
    expect(switches()[0].getAttribute('aria-pressed')).toBe('true');
    await act(async () => switches()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, ctrlKey: true })));
    expect([...getManualGalleryStackSelection(stack.stackId!)!]).toEqual([stack.stackMembers![3].id]);
    await act(async () => switches()[0].click());
    expect(getManualGalleryStackSelection(stack.stackId!)!.size).toBe(3);
    await act(async () => switches()[2].click());
    expect(getManualGalleryStackSelection(stack.stackId!)!.size).toBe(4);
    await act(async () => { for (const button of switches()) button.click(); });
    expect(getManualGalleryStackSelection(stack.stackId!)!.size).toBe(0);
    act(() => restoreGalleryStackSelectionsFromSession());
    expect(switches().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(false);
    expect(switches().every(button => button.type === 'button' && button.tabIndex === 0)).toBe(true);
  });

  it('disables exported formats and distinguishes unavailable metadata without discarding intent', async () => {
    const stack = makeGalleryStack(1, ['JPEG', 'DNG'], [0]);
    stack.stackFormats = [{ format: 'JPEG', isRaw: false }, { format: 'DNG', isRaw: true }];
    await mountStack(stack);
    expect(switches()[0].disabled).toBe(true);
    expect(switches()[0].getAttribute('aria-pressed')).toBe('false');
    expect(switches()[1].getAttribute('aria-pressed')).toBe('true');
    await act(async () => switches()[0].click());
    expect(getManualGalleryStackSelection(stack.stackId!)).toBeUndefined();
    await act(async () => switches()[1].click());
    await mountStack({ ...stack, stackMembers: null });
    expect(switches().every(button => button.disabled && button.dataset.state === 'unavailable' && !button.hasAttribute('aria-pressed') && !!button.title)).toBe(true);
    expect(getManualGalleryStackSelection(stack.stackId!)!.size).toBe(0);
    await mountStack(stack);
    expect(switches()[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('reconciles changed complete snapshots after render without adding new members', async () => {
    const stack = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG']);
    setManualGalleryStackSelection(stack, new Set(stack.stackMembers!.map(member => member.id)));
    await mountStack(stack);
    const next = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG', 'PNG'], [1]);
    await mountStack(next);
    expect([...getManualGalleryStackSelection(stack.stackId!)!]).toEqual([next.id, next.stackMembers![2].id]);
  });
  it.each([true, false, undefined])('shows the export icon only for positive asset metadata (%s)', async isGenzoRoomExport => {
    await act(async () => root.render(<PhotoCard asset={{ ...interactionAsset, isGenzoRoomExport }} language="en" edited queueKnown
      onQueueToggle={vi.fn()} onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} />));
    const badge = host.querySelector('.genzoroom-export-badge');
    expect(!!badge).toBe(isGenzoRoomExport === true);
    if (badge) {
      expect(badge.getAttribute('role')).toBe('img');
      expect(badge.getAttribute('title')).toBe('Exported by GenzoRoom');
      expect(badge.getAttribute('aria-label')).toBe('Exported by GenzoRoom');
      expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(badge.querySelector('text, button, [tabindex]')).toBeNull();
      expect(badge.hasAttribute('tabindex')).toBe(false);
      expect(badge.tagName).toBe('SPAN');
      expect(badge.parentElement).toBe(host.querySelector('.photo-card-badges'));
      expect(host.querySelector('.edited-badge')?.parentElement).toBe(badge.parentElement);
      expect(host.querySelector('.photo-card-button')?.contains(badge)).toBe(false);
    }
  });
  it('localizes the GenzoRoom export badge in Japanese', async () => {
    await i18n.changeLanguage('ja');
    await act(async () => root.render(<PhotoCard asset={{ ...interactionAsset, isGenzoRoomExport: true }} language="ja"
      onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} />));
    const badge = host.querySelector('.genzoroom-export-badge')!;
    expect(badge.getAttribute('title')).toBe('GenzoRoomで出力');
    expect(badge.getAttribute('aria-label')).toBe('GenzoRoomで出力');
  });
  it.each([false, true])('isolates the sibling Queue button from navigation and selection (selection mode %s)', async selectionMode => {
    const onSelect = vi.fn(), onToggleSelection = vi.fn(), onExtendSelection = vi.fn(), onPreviewRequest = vi.fn(), onQueueToggle = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en" edited selected={selectionMode}
      selectionMode={selectionMode} queueKnown onQueueToggle={onQueueToggle}
      onSelect={onSelect} onToggleSelection={onToggleSelection} onExtendSelection={onExtendSelection} onPreviewRequest={onPreviewRequest} />));
    const photo = host.querySelector<HTMLButtonElement>('.photo-card-button')!;
    const badge = host.querySelector<HTMLButtonElement>('.edited-badge')!;
    expect(photo.contains(badge)).toBe(false);
    expect(host.querySelector('button button')).toBeNull();
    expect(badge.parentElement?.previousElementSibling).toBe(photo);
    expect(badge.title).not.toContain('[Q]');
    await act(async () => badge.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(onQueueToggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleSelection).not.toHaveBeenCalled();
    expect(onExtendSelection).not.toHaveBeenCalled();
    expect(onPreviewRequest).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(selectionMode);
    expect(photo.getAttribute('aria-pressed')).toBe(selectionMode ? 'true' : 'false');
  });
  it('selects only on normal click and uses Primary and Shift for explicit selection actions', async () => {
    const onSelect = vi.fn(), onToggleSelection = vi.fn(), onExtendSelection = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en"
      onSelect={onSelect} onToggleSelection={onToggleSelection} onExtendSelection={onExtendSelection} />));
    const photo = host.querySelector<HTMLButtonElement>('.photo-card-button')!;
    await act(async () => photo.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSelect).toHaveBeenCalledOnce();
    await act(async () => photo.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(onToggleSelection).toHaveBeenCalledOnce();
    const shiftClick = new MouseEvent('click', { bubbles: true, shiftKey: true });
    await act(async () => photo.dispatchEvent(shiftClick));
    expect(onExtendSelection).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('uses Command as Primary for photo toggles on macOS', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
    const onSelect = vi.fn(), onToggleSelection = vi.fn(), onExtendSelection = vi.fn();
    try {
      await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en"
        onSelect={onSelect} onToggleSelection={onToggleSelection} onExtendSelection={onExtendSelection} />));
      const photo = host.querySelector<HTMLButtonElement>('.photo-card-button')!;
      await act(async () => photo.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
      expect(onSelect).toHaveBeenCalledOnce();
      await act(async () => photo.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
      expect(onToggleSelection).toHaveBeenCalledOnce();
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, 'platform', descriptor);
      else Reflect.deleteProperty(window.navigator, 'platform');
    }
  });

  it('keeps checkbox normal toggles and Shift range clicks single-shot', async () => {
    const onSelect = vi.fn(), onToggleSelection = vi.fn(), onExtendSelection = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en" selectionMode
      onSelect={onSelect} onToggleSelection={onToggleSelection} onExtendSelection={onExtendSelection} />));
    const checkbox = host.querySelector<HTMLInputElement>('.photo-selection-input')!;
    await act(async () => checkbox.click());
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledOnce();
    onToggleSelection.mockClear();
    const shiftClick = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true });
    await act(async () => checkbox.dispatchEvent(shiftClick));
    expect(shiftClick.defaultPrevented).toBe(true);
    expect(onToggleSelection).not.toHaveBeenCalled();
    expect(onExtendSelection).toHaveBeenCalledOnce();
    await act(async () => checkbox.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onToggleSelection).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('requests Preview on double-click after the normal click selection', async () => {
    const onSelect = vi.fn(), onToggleSelection = vi.fn(), onExtendSelection = vi.fn(), onPreviewRequest = vi.fn();
    await act(async () => root.render(<PhotoCard asset={interactionAsset} language="en"
      onSelect={onSelect} onToggleSelection={onToggleSelection} onExtendSelection={onExtendSelection}
      onPreviewRequest={onPreviewRequest} />));
    const photo = host.querySelector<HTMLButtonElement>('.photo-card-button')!;
    await act(async () => {
      photo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      photo.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onPreviewRequest).toHaveBeenCalledOnce();
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
    expect(markup).toContain('>DNG</button>');
    expect(markup).toContain(`class="stack-asset-count">${count}</span>`);
    expect(markup).toContain(`aria-label="Stack, ${count} assets"`);
    expect(markup).not.toContain('stack-asset-count-error');
    expect(markup).toContain('class="edited-badge"');
    expect(markup).not.toContain('thumbnail stacked');
  });

  it('shows the singleton Stack as an invalid Stack warning without changing its badge structure', () => {
    const markup = renderBadge('JPEG', false, 'photo.jpg', undefined, 'stack-id', 1);
    expect(markup).toContain('role="group" aria-label="Invalid Stack, 1 asset"');
    expect(markup).toContain('data-state="unavailable"');
    expect(markup).toContain('class="stack-asset-count stack-asset-count-error">1</span>');
  });

  it.each([
    ['JPEG', false, [{ format: 'JPEG', isRaw: false }, { format: 'DNG', isRaw: true }], ['JPEG', 'DNG'], 2],
    ['JPEG', false, [{ format: 'JPEG', isRaw: false }, { format: 'JPEG', isRaw: false }, { format: 'DNG', isRaw: true }], ['JPEG', 'DNG'], 3],
    ['JPEG', false, [{ format: 'JPEG', isRaw: false }, { format: 'JPEG', isRaw: false }], ['JPEG'], 2],
    ['DNG', true, [{ format: 'DNG', isRaw: true }, { format: 'JPEG', isRaw: false }], ['DNG', 'JPEG'], 2],
    ['JPEG', false, [{ format: 'JPEG', isRaw: false }, { format: 'HEIC', isRaw: false }, { format: 'DNG', isRaw: true }], ['JPEG', 'HEIC', 'DNG'], 3],
  ] as const)('renders Stack format list in its supplied stable order', (coverFormat, coverRaw, formats, expected, count) => {
    const markup = renderBadge(coverFormat, coverRaw, 'photo.jpg', undefined, 'stack-id', count, [...formats]);
    const card = document.createElement('div');
    card.innerHTML = markup;
    const badges = Array.from(card.querySelectorAll('.stack-format-badges .format-badge'));
    expect(badges.map(badge => badge.textContent)).toEqual(expected);
    expect(badges.filter(badge => badge.textContent === 'JPEG')).toHaveLength(expected.filter(format => format === 'JPEG').length);
    expect(card.querySelector('.stack-asset-count')?.textContent).toBe(String(count));
    expect(card.querySelectorAll('.stack-format-badges .format-badge')).toHaveLength(expected.length);
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
    expect(markup).toContain('class="filename-middle-ellipsis"');
  });

  it('renders a keyboard-operable selection checkbox without changing normal card navigation', () => {
    const markup = renderBadge('JPEG', false, 'photo.jpg');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('class="photo-selection-input"');
    expect(markup).toContain('aria-label="Select photo.jpg"');
    expect(markup).toContain('aria-pressed="false"');
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
      onSelect={vi.fn()}
      onToggleSelection={vi.fn()}
      onExtendSelection={vi.fn()}
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
      <PhotoCard key={asset.id} asset={asset} language="en" onSelect={vi.fn()} onToggleSelection={vi.fn()} onExtendSelection={vi.fn()} />
    ))}</div>);

    expect(markup.match(/<article/g)).toHaveLength(100);
    expect(markup.match(/<img src="\/api\/assets\/asset-\d+\/thumbnail"/g)).toHaveLength(100);
    expect(markup.match(/class="format-badge"/g)).toHaveLength(100);
    expect(markup).toContain('photo-100.jpg');
  });
});
