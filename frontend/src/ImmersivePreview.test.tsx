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
    source: 'exportManagement', ...handlers, ...overrides };
  act(() => root.render(<ImmersivePreview {...props} />));
  return { handlers, props };
}
const image = () => host.querySelector('img')!;
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const press = (key: string) => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); localStorage.removeItem(SHOW_KEYBOARD_SHORTCUTS_KEY);
  updateSetting('showKeyboardShortcuts', true); vi.unstubAllGlobals();
});

describe('ImmersivePreview', () => {
  it('fits the image, starts with both bars, and toggles bars only from the photo area', () => {
    mount();
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
    expect(host.querySelector('.immersive-preview-bottombar')).not.toBeNull();
    act(() => photo.click());
    expect(host.querySelector('.immersive-preview-bottombar')).toBeNull();
    expect(fitStyle().objectFit).toBe('contain');
    act(() => photo.click());
    expect(host.querySelector('.immersive-preview-bottombar')).not.toBeNull();
    expect(fitStyle().objectFit).toBe('contain');
  });

  it('navigates only within the opening sequence and targets the displayed photo for callbacks', () => {
    const { handlers, props } = mount();
    const backgroundShortcut = vi.fn(); window.addEventListener('keydown', backgroundShortcut);
    press('ArrowRight'); expect(image().alt).toBe(c.filename);
    press('ArrowRight'); expect(host.querySelector('.immersive-preview-position')!.textContent).toBe('3 / 3');
    press(' '); press('q'); press('w');
    expect(handlers.onToggleSelection).toHaveBeenCalledWith(c.id);
    expect(handlers.onToggleQueue).toHaveBeenCalledWith(c.id);
    expect(handlers.onToggleArmed).toHaveBeenCalledWith(c.id);
    expect(backgroundShortcut).not.toHaveBeenCalled();
    window.removeEventListener('keydown', backgroundShortcut);
    act(() => root.render(<ImmersivePreview {...props} assets={[a]} selectedAssetIds={new Set([c.id])} queuedAssetIds={new Set()} />));
    expect(image().alt).toBe(c.filename);
    press('ArrowLeft'); expect(image().alt).toBe(b.filename);
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
