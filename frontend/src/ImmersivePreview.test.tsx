// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentAsset } from './assets';
import { ImmersivePreview, type ImmersivePreviewProps } from './ImmersivePreview';
import { SHOW_KEYBOARD_SHORTCUTS_KEY, updateSetting } from './appSettings';
import './i18n';
import './style.css';

const a: RecentAsset = { id: 'a', filename: 'a-long-photo-name.jpg', date: '', thumbnail_url: '/thumb/a', format: 'JPEG', is_raw: false };
const b: RecentAsset = { ...a, id: 'b', filename: 'b.jpg' };
const c: RecentAsset = { ...a, id: 'c', filename: 'c.jpg' };
let host: HTMLDivElement;
let root: Root;

function mount(overrides: Partial<ImmersivePreviewProps> = {}) {
  const handlers = { onToggleSelection: vi.fn(), onToggleQueue: vi.fn(), onToggleArmed: vi.fn(), onClose: vi.fn() };
  const props: ImmersivePreviewProps = { assets: [a, b, c], startAssetId: 'b', selectedAssetIds: new Set(), queuedAssetIds: new Set(),
    source: 'gallery', ...handlers, ...overrides };
  act(() => root.render(<ImmersivePreview {...props} />));
  return { handlers, props };
}
const image = () => host.querySelector('img')!;
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const press = (key: string) => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
const clickPhoto = (clientX: number, target: HTMLElement = host.querySelector<HTMLElement>('.immersive-preview-photo')!, buttonCode = 0) =>
  act(() => target.dispatchEvent(new MouseEvent('click', { clientX, button: buttonCode, bubbles: true, cancelable: true })));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); localStorage.removeItem(SHOW_KEYBOARD_SHORTCUTS_KEY);
  updateSetting('showKeyboardShortcuts', true); vi.unstubAllGlobals();
});

describe('ImmersivePreview', () => {
  it('fits the image and keeps both toolbars visible when the photo area is clicked', () => {
    const { handlers } = mount();
    expect(image().getAttribute('src')).toBe('/api/assets/b/immersive-preview');
    const photo = host.querySelector<HTMLElement>('.immersive-preview-photo')!;
    const fitStyle = () => ({
      position: getComputedStyle(image()).position,
      width: getComputedStyle(image()).width,
      height: getComputedStyle(image()).height,
      objectFit: getComputedStyle(image()).objectFit,
      photoPosition: getComputedStyle(photo).position,
      photoOverflow: getComputedStyle(photo).overflow,
    });
    expect(fitStyle()).toEqual({ position: 'absolute', width: '100%', height: '100%', objectFit: 'contain',
      photoPosition: 'relative', photoOverflow: 'hidden' });
    expect(host.querySelector('kbd')?.textContent).toBe('Space');
    expect(host.querySelector('.immersive-preview-topbar')).not.toBeNull();
    expect(host.querySelector('.immersive-preview-bottombar')).not.toBeNull();
    act(() => button('Selection').click());
    expect(handlers.onToggleSelection).toHaveBeenCalledWith(b.id);
    clickPhoto(window.innerWidth / 2);
    expect(image().alt).toBe(b.filename);
    expect(host.querySelector('.immersive-preview-topbar')).not.toBeNull();
    expect(host.querySelector('.immersive-preview-bottombar')).not.toBeNull();
    expect(fitStyle().objectFit).toBe('contain');
    act(() => button('Export Queue').click());
    expect(handlers.onToggleQueue).toHaveBeenCalledWith(b.id);
  });

  it('uses the viewport outer 20 percent for photo-area navigation, including its black margins', () => {
    mount();
    const width = window.innerWidth;
    clickPhoto(width * 0.2);
    expect(image().alt).toBe(b.filename);
    clickPhoto(width * 0.2 - 1);
    expect(image().alt).toBe(a.filename);
    clickPhoto(width * 0.2);
    expect(image().alt).toBe(a.filename);
    clickPhoto(width * 0.8 - 1);
    expect(image().alt).toBe(a.filename);
    clickPhoto(width * 0.8);
    expect(image().alt).toBe(b.filename);
    clickPhoto(width, image());
    expect(image().alt).toBe(c.filename);
    clickPhoto(width);
    expect(image().alt).toBe(c.filename);
  });

  it('ignores right clicks and photo clicks never toggle selection or Queue', () => {
    const { handlers } = mount();
    clickPhoto(window.innerWidth * 0.8, undefined, 2);
    expect(image().alt).toBe(b.filename);
    clickPhoto(0);
    expect(image().alt).toBe(a.filename);
    expect(handlers.onToggleSelection).not.toHaveBeenCalled();
    expect(handlers.onToggleQueue).not.toHaveBeenCalled();
    expect(host.querySelector('.immersive-preview-topbar')).not.toBeNull();
    expect(host.querySelector('.immersive-preview-bottombar')).not.toBeNull();
  });

  it('shows the existing GenzoRoom export badge without shifting the centered filename', () => {
    const exported = { ...a, isGenzoRoomExport: true };
    mount({ assets: [exported, b, c], startAssetId: exported.id });
    const title = () => host.querySelector<HTMLElement>('.immersive-preview-title')!;
    const filename = () => host.querySelector<HTMLElement>('.immersive-preview-filename')!;
    expect(title().querySelector('.genzoroom-export-badge')).not.toBeNull();
    expect(filename().textContent).toBe(exported.filename);
    expect(getComputedStyle(filename()).textAlign).toBe('center');
    expect(getComputedStyle(filename()).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(title()).columnGap).toBe('8px');
    expect(getComputedStyle(filename()).maxWidth).toBe('calc(100% - 72px)');
    expect(getComputedStyle(title().firstElementChild!).flexBasis).toBe(getComputedStyle(title().lastElementChild!).flexBasis);
    press('ArrowRight');
    expect(title().querySelector('.genzoroom-export-badge')).toBeNull();
    expect(filename().textContent).toBe(b.filename);
    expect(getComputedStyle(filename()).textAlign).toBe('center');
  });

  it('disables Q for unedited Queue-out photos and updates availability while navigating', () => {
    const onToggleQueue = vi.fn();
    const queueControlByAssetId = new Map([
      [a.id, { edited: false, queueKnown: true, queueCurrent: true }],
      [b.id, { edited: true, queueKnown: true, queueCurrent: true }],
      [c.id, { edited: false, queueKnown: true, queueCurrent: true, queueStatus: 'queued' as const }],
    ]);
    mount({ source: 'gallery', assets: [a, b, c], startAssetId: a.id, queueControlByAssetId,
      queuedAssetIds: new Set([c.id]), onToggleQueue });
    const queueButton = () => button('Export Queue');
    expect(queueButton().disabled).toBe(true);
    expect(queueButton().classList.contains('immersive-preview-queue-disabled')).toBe(true);
    expect(queueButton().getAttribute('aria-pressed')).toBe('false');
    act(() => queueButton().click());
    press('q');
    expect(onToggleQueue).not.toHaveBeenCalled();
    press('ArrowRight');
    expect(queueButton().disabled).toBe(false);
    press('q');
    expect(onToggleQueue).toHaveBeenLastCalledWith(b.id);
    press('ArrowRight');
    expect(queueButton().disabled).toBe(false);
    expect(queueButton().getAttribute('aria-pressed')).toBe('true');
    press('q');
    expect(onToggleQueue).toHaveBeenLastCalledWith(c.id);
    expect(onToggleQueue).toHaveBeenCalledTimes(2);
  });

  it.each([
    { edited: true, queueKnown: false, queueCurrent: true },
    { edited: true, queueKnown: true, queueCurrent: false },
    { edited: true, queueKnown: true, queueCurrent: true, busy: true },
    { edited: true, queueKnown: true, queueCurrent: true, queueStatus: 'waiting' as const },
    { edited: true, queueKnown: true, queueCurrent: true, queueStatus: 'encoding' as const },
    { edited: true, queueKnown: true, queueCurrent: true, queueStatus: 'registering' as const },
  ])('keeps existing Queue guards disabled in the immersive preview (%j)', control => {
    const onToggleQueue = vi.fn();
    mount({ source: 'gallery', queueControlByAssetId: new Map([[b.id, control]]), onToggleQueue });
    expect(button('Export Queue').disabled).toBe(true);
    press('q');
    expect(onToggleQueue).not.toHaveBeenCalled();
  });

  it('navigates only within the opening sequence and targets the displayed photo for callbacks', () => {
    const { handlers, props } = mount({ source: 'exportManagement', exportControlByAssetId: new Map(
      [a, b, c].map(asset => [asset.id, { queueEnabled: true, armEnabled: true }])) });
    const backgroundShortcut = vi.fn(); window.addEventListener('keydown', backgroundShortcut);
    press('ArrowRight'); expect(image().alt).toBe(c.filename);
    press('ArrowRight'); expect(host.querySelector('.immersive-preview-position')!.textContent).toBe('3 / 3');
    press(' '); press('q'); press('w');
    expect(handlers.onToggleSelection).not.toHaveBeenCalled();
    expect(handlers.onToggleQueue).toHaveBeenCalledWith(c.id);
    expect(handlers.onToggleArmed).toHaveBeenCalledWith(c.id);
    expect(backgroundShortcut).not.toHaveBeenCalled();
    window.removeEventListener('keydown', backgroundShortcut);
    act(() => root.render(<ImmersivePreview {...props} assets={[a]} selectedAssetIds={new Set([c.id])} queuedAssetIds={new Set()} />));
    expect(image().alt).toBe(c.filename);
    press('ArrowLeft'); expect(image().alt).toBe(b.filename);
  });

  it('shows only Q/W in Export, consumes Space from focused buttons, and shares disabled guards with keys', () => {
    const { handlers, props } = mount({ source: 'exportManagement', queuedAssetIds: new Set([b.id]),
      exportControlByAssetId: new Map([[b.id, { queueEnabled: true, armEnabled: true }]]) });
    expect(button('Selection')).toBeUndefined();
    expect(host.querySelectorAll('.immersive-preview-bottombar button')).toHaveLength(2);
    const background = vi.fn(); window.addEventListener('keydown', background);
    const queueButton = button('Export Queue');
    act(() => queueButton.focus());
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => queueButton.dispatchEvent(space));
    expect(space.defaultPrevented).toBe(true);
    const repeatedSpace = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, repeat: true });
    act(() => queueButton.dispatchEvent(repeatedSpace));
    expect(repeatedSpace.defaultPrevented).toBe(true);
    expect(background).not.toHaveBeenCalled();
    expect(handlers.onToggleSelection).not.toHaveBeenCalled();
    press('q'); press('w');
    expect(handlers.onToggleQueue).toHaveBeenCalledExactlyOnceWith(b.id);
    expect(handlers.onToggleArmed).toHaveBeenCalledExactlyOnceWith(b.id);
    act(() => root.render(<ImmersivePreview {...props} queuedAssetIds={new Set()}
      exportControlByAssetId={new Map([[b.id, { queueEnabled: false, armEnabled: false }]])} />));
    expect(button('Export Queue').disabled).toBe(true);
    expect(button('Export readiness').disabled).toBe(true);
    act(() => { button('Export Queue').click(); button('Export readiness').click(); });
    press('q'); press('w');
    expect(handlers.onToggleQueue).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleArmed).toHaveBeenCalledTimes(1);
    expect(image().alt).toBe(b.filename);
    expect(host.querySelector('.immersive-preview-position')?.textContent).toBe('2 / 3');
    window.removeEventListener('keydown', background);
  });

  it('keeps the target list when selection and Queue membership change, and hides W in Gallery', () => {
    const { props, handlers } = mount({ source: 'gallery', armedAssetIds: new Set([b.id]) });
    expect(button('Export readiness')).toBeUndefined();
    press('w'); expect(handlers.onToggleArmed).not.toHaveBeenCalled();
    act(() => root.render(<ImmersivePreview {...props} assets={[a]} selectedAssetIds={new Set([b.id])} queuedAssetIds={new Set()} />));
    expect(image().alt).toBe(b.filename);
    expect(button('Selection: On')).toBeDefined();
  });

  it('closes with V, Escape, and X and respects shortcut display preference', () => {
    localStorage.setItem(SHOW_KEYBOARD_SHORTCUTS_KEY, 'false'); updateSetting('showKeyboardShortcuts', false);
    const { handlers } = mount();
    expect(host.querySelector('kbd')).toBeNull();
    press('v'); press('Escape'); act(() => button('×').click());
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['other', false], ['mac', true], ['unknown', false],
  ] as const)('uses OS bar placement for %s', (platform, isMac) => {
    const browserPlatform = platform === 'mac' ? 'MacIntel' : platform === 'other' ? 'Linux x86_64' : '';
    Object.defineProperty(navigator, 'platform', { configurable: true, value: browserPlatform });
    mount();
    expect(host.querySelector('.immersive-preview')!.getAttribute('data-platform')).toBe(isMac ? 'mac' : 'other');
    const first = host.querySelector('.immersive-preview-topbar')!.firstElementChild!;
    const last = host.querySelector('.immersive-preview-topbar')!.lastElementChild!;
    const filename = host.querySelector<HTMLElement>('.immersive-preview-filename')!;
    expect(first.matches('button')).toBe(isMac);
    expect(first.textContent).toBe(isMac ? '×' : '2 / 3');
    expect(getComputedStyle(isMac ? first : last).justifySelf).toBe(isMac ? 'start' : 'end');
    expect(getComputedStyle(filename).textAlign).toBe('center');
    expect(getComputedStyle(host.querySelector('.immersive-preview-topbar')!).paddingLeft)
      .toBe(getComputedStyle(host.querySelector('.immersive-preview-topbar')!).paddingRight);
  });
});
