// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import type { EditRecipe } from './editing';
import i18n from './i18n';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: `${id}.jpg`, date: '2026-09-17T00:00:00Z', format: 'JPEG', is_raw: false,
    preview_url: `/preview/${id}`, thumbnail_url: `/thumbnail/${id}`, exif: {},
  })),
}));
vi.mock('./ImageViewer', () => ({
  ImageViewer: ({ recipe }: { recipe: EditRecipe }) => <pre data-recipe>{JSON.stringify(recipe)}</pre>,
}));

let host: HTMLDivElement;
let root: Root;
const recipe = (): EditRecipe => JSON.parse(host.querySelector('[data-recipe]')!.textContent!);
const grading = () => host.querySelectorAll<HTMLElement>('.adjustment-category')[2];
const slider = () => grading().querySelector<HTMLInputElement>('input[type="range"]')!;
const history = () => Array.from(host.querySelectorAll('.edit-history li'), (item) => item.textContent);
function click(element: HTMLElement) { act(() => element.click()); }
function key(value: string, target: EventTarget) {
  act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[{ pathname: '/anshitsu/a', state: {
      selectedAssets: [{ id: 'a', filename: 'a.jpg', date: '2026-09-17T00:00:00Z', format: 'JPEG', is_raw: false, thumbnail_url: '/thumbnail/a' }],
      activeAssetId: 'a',
    } }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Color Grading controls', () => {
  it('renders between Basic and Color with a Shadows Temperature slider', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), (item) => item.textContent))
      .toEqual(['White Balance', 'Basic', 'Color Grading', 'Color']);
    expect(grading().querySelector('.adjustment-subsection-title')?.textContent).toBe('Shadows');
    expect(grading().querySelector('label')?.textContent).toBe('Temperature');
    expect([slider().min, slider().max, slider().step, slider().value]).toEqual(['-100', '100', '1', '0']);
    expect(slider().classList.contains('has-gradient')).toBe(true);
  });

  it('uses existing keyboard coalescing, bypass, Reset, and All Reset behavior', () => {
    act(() => slider().focus());
    key('ArrowRight', slider());
    key('ArrowUp', slider());
    expect(recipe().adjustments.shadowsTemperature).toBe(11);
    act(() => vi.advanceTimersByTime(500));
    expect(history()).toEqual(['Shadows Temperature 0 → +11']);

    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorGradingEnabled).toBe(false);
    expect(recipe().adjustments.shadowsTemperature).toBe(11);
    expect(slider().disabled).toBe(true);
    click(grading().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(recipe().adjustments.shadowsTemperature).toBe(0);
    expect(recipe().colorGradingEnabled).toBe(false);
    click(host.querySelector<HTMLButtonElement>('.workspace-section-action')!);
    expect(recipe()).toEqual(expect.objectContaining({ version: 11, colorGradingEnabled: true }));
    expect(Object.values(recipe().adjustments).every((value) => value === 0)).toBe(true);
  });
});
