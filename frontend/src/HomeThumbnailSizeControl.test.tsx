// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_THUMBNAIL_COLUMNS_KEY, updateSetting } from './appSettings';
import { changeAppLanguage } from './i18n';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';

let host: HTMLDivElement;
let root: Root;
async function change(control: HTMLElement, value: string) {
  const slider = control.querySelector<HTMLInputElement>('input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); updateSetting('homeThumbnailColumns', 6); await changeAppLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<HomeThumbnailSizeControl />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); updateSetting('homeThumbnailColumns', 6); });

describe('Home thumbnail size controls', () => {
  it('uses visibly different thumbnail sizes for the smaller and larger controls', () => {
    const icons = [...host.querySelectorAll('.thumbnail-size-icon svg path')].map(path => path.getAttribute('d'));
    expect(icons[0]).toContain('M3 3h5v5H3z');
    expect(icons[1]).toBe('M3 3h14v14H3z');
    expect(icons[0]).not.toBe(icons[1]);
  });

  it('moves one step per icon click and disables both limits', async () => {
    const home = host.querySelector<HTMLElement>('.thumbnail-size-control')!;
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('6 columns');
    await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.click());
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('7');
    for (let i = 0; i < 4; i++) await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.click());
    expect(home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.disabled).toBe(true);
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('8 columns');
    for (let i = 0; i < 5; i++) await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!.click());
    expect(home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!.disabled).toBe(true);
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('3 columns');
  });
  it('updates the saved Home setting immediately while the slider moves', async () => {
    const home = host.querySelector<HTMLElement>('.thumbnail-size-control')!;
    await change(home, '0');
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('8');
    expect(home.querySelector('input')!.value).toBe('0');
    await change(home, '5');
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('3 columns');
  });
});
