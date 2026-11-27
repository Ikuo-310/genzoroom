// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawAdjustmentControls } from './RawAdjustmentControls';
import { rawSettings } from './test/rawSettings';
import { RAW_VIGNETTE_STYLES } from './rawApi';
import { defaultRawDevelopmentPanelUi, RAW_DEVELOPMENT_PANEL_UI_KEY, updateSetting } from './appSettings';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); updateSetting('rawDevelopmentPanelUi', defaultRawDevelopmentPanelUi()); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); updateSetting('rawDevelopmentPanelUi', defaultRawDevelopmentPanelUi()); window.localStorage.removeItem(RAW_DEVELOPMENT_PANEL_UI_KEY); });
it('persists independent RAW panel folds and selections across remount and asset changes without edit operations', async () => {
  const asset = (id: string) => ({ workspaceId: 'workspace', assetId: id, handle: 'handle', documentToken: 'token', generation: 1, revision: 1 });
  const raw = { assetId: 'asset-a', status: 'ready', settings: rawSettings(asset('asset-a')), history: {}, operate: vi.fn(),
    pointColorRangeIndex: null, setPointColorRangeIndex: vi.fn(),
    beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
  function draw() { act(() => root.render(<RawAdjustmentControls raw={raw as never} />)); }
  const category = (name: string) => host.querySelector<HTMLButtonElement>(`.raw-adjustment-category.is-${name} > .adjustment-category-header .adjustment-category-title`)!;
  const categoryOpen = (name: string) => category(name).getAttribute('aria-expanded') === 'true';
  draw();
  for (const name of ['basic', 'color', 'curves', 'effects', 'detail']) expect(categoryOpen(name)).toBe(true);
  expect(categoryOpen('calibration')).toBe(false);
  expect(host.querySelector('.raw-color-mixer-title')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.raw-color-grading-title')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.raw-optics-header .adjustment-category-title')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.raw-optics-fold-header button')?.getAttribute('aria-expanded')).toBe('false');
  act(() => category('basic').click()); act(() => category('curves').click());
  const mixer = host.querySelector<HTMLElement>('.raw-color-mixer')!;
  const grading = host.querySelector<HTMLElement>('.raw-color-grading')!;
  act(() => mixer.querySelector<HTMLButtonElement>('.raw-color-mixer-title')!.click());
  act(() => grading.querySelector<HTMLButtonElement>('.raw-color-grading-title')!.click());
  act(() => host.querySelector<HTMLButtonElement>('.raw-color-mixer-swatch[aria-label="Blue"]')!.click());
  act(() => host.querySelectorAll<HTMLInputElement>('.raw-grading-band input')[2].click());
  const lens = host.querySelector<HTMLElement>('.raw-optics-panel')!;
  const lensToggle = lens.querySelector<HTMLButtonElement>('.raw-optics-header .adjustment-category-title')!;
  act(() => lens.querySelector<HTMLButtonElement>('.raw-optics-fold-header button')!.click());
  act(() => lensToggle.click());
  act(() => category('detail').click());
  expect(JSON.parse(localStorage.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY)!)).toEqual({
    version: 1,
    categories: { basic: false, color: true, curves: false, effects: true, detail: false, calibration: false },
    subcategories: { mixer: true, grading: true, pointColor: false, lensCorrections: false, defringe: true },
    selection: { mixerColor: 'blue', gradingBand: 'highlights' },
  });
  expect(raw.operate).not.toHaveBeenCalled();
  expect(raw.beginControls).not.toHaveBeenCalled(); expect(raw.changeControls).not.toHaveBeenCalled();
  const saved = JSON.parse(localStorage.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY)!);
  for (const assetId of ['asset-b', 'asset-a']) {
    raw.assetId = assetId; raw.settings = rawSettings(asset(assetId)); draw();
    expect(categoryOpen('basic')).toBe(false); expect(categoryOpen('color')).toBe(true);
    expect(categoryOpen('curves')).toBe(false); expect(categoryOpen('effects')).toBe(true); expect(categoryOpen('detail')).toBe(false);
    expect(host.querySelector('.raw-color-mixer-title')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.raw-color-grading-title')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.raw-color-mixer-swatch[aria-label="Blue"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelectorAll<HTMLInputElement>('.raw-grading-band input')[2].checked).toBe(true);
    expect(localStorage.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY)).toBe(JSON.stringify(saved));
  }
  act(() => root.unmount()); root = createRoot(host); raw.assetId = 'asset-a'; raw.settings = rawSettings(asset('asset-a')); draw();
  expect(host.querySelector('.raw-color-mixer-title')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.raw-color-grading-title')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.raw-color-mixer-swatch[aria-label="Blue"]')?.getAttribute('aria-checked')).toBe('true');
  act(() => category('detail').click());
  expect(host.querySelector('.raw-optics-header .adjustment-category-title')?.getAttribute('aria-expanded')).toBe('false');
  act(() => host.querySelector('.raw-optics-header .adjustment-category-title')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(host.querySelector('.raw-optics-fold-header button')?.getAttribute('aria-expanded')).toBe('true');
  expect(raw.operate).not.toHaveBeenCalled();
});
it.each(['ja', 'en'])('shows independent calibration controls and operations in %s', async language => {
  await i18n.changeLanguage(language);
  const settings = rawSettings({ workspaceId: 'workspace', assetId: 'asset', handle: 'handle', documentToken: 'token', generation: 1, revision: 1 });
  const operate = vi.fn();
  const raw = { assetId: 'asset', status: 'ready', settings, history: {}, operate,
    pointColorRangeIndex: null, setPointColorRangeIndex: vi.fn(),
    beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
  const draw = () => act(() => root.render(<RawAdjustmentControls raw={raw as never} />));
  draw();
  const panel = host.querySelector<HTMLElement>('.raw-adjustment-category.is-calibration')!;
  expect(panel.previousElementSibling?.classList.contains('is-detail')).toBe(true);
  const fold = panel.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  act(() => fold.click());
  const ranges = [...panel.querySelectorAll<HTMLInputElement>('input[type="range"]')];
  expect(ranges).toHaveLength(7);
  expect(ranges.every(range => range.min === '-100' && range.max === '100' && range.step === '1')).toBe(true);
  expect(ranges.map(range => range.style.getPropertyValue('--adjustment-track-gradient'))).toEqual([
    'linear-gradient(to right, #246123, #2c552c, #394739, #4a3d4c, #6b336b, #872c87)',
    'linear-gradient(to right, #e0306a, #e08a30)', 'linear-gradient(to right, #7a7a7a, #e03a3a)',
    'linear-gradient(to right, #b0c030, #30c08a)', 'linear-gradient(to right, #7a7a7a, #40b050)',
    'linear-gradient(to right, #30a0d0, #8040d0)', 'linear-gradient(to right, #7a7a7a, #3a60e0)',
  ]);
  expect(panel.textContent).toContain(language === 'ja' ? 'レッド原色' : 'Red Primary');
  expect(panel.textContent).not.toContain('°');
  expect(panel.textContent).not.toContain('workspace.');
  const toggle = panel.querySelector<HTMLButtonElement>('[data-category-switch]')!;
  act(() => toggle.click());
  expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionToggle', metadata: { section: 'calibration', enabled: false } });
  act(() => panel.querySelector<HTMLButtonElement>('.adjustment-category-reset')!.click());
  expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionReset', metadata: { section: 'calibration' } });
  act(() => panel.querySelector<HTMLButtonElement>('.adjustment-reset')!.click());
  expect(operate).toHaveBeenLastCalledWith({ kind: 'controlReset', metadata: { control: 'calibration.shadowsTint' } });
  settings.values['calibration.redHue'] = 23;
  settings.sections.calibration = false;
  settings.sections.color = true;
  draw();
  expect(ranges.every(range => range.disabled)).toBe(true);
  expect(settings.values['calibration.redHue']).toBe(23);
  settings.sections.calibration = true;
  settings.sections.color = false;
  draw();
  expect(ranges.every(range => !range.disabled)).toBe(true);
});
it.each(['ja', 'en'])('uses desired amount for dependents and preserves values/mode while inactive in %s', async language => {
  await i18n.changeLanguage(language);
  const settings = rawSettings({ workspaceId: 'workspace', assetId: 'asset', handle: 'handle', documentToken: 'token', generation: 1, revision: 1 });
  Object.assign(settings.values, { 'vignette.midpoint': 23, 'vignette.feather': 87, 'vignette.roundness': -34, 'vignette.highlights': 89 });
  const operate = vi.fn();
  const raw = { assetId: 'asset', status: 'ready', settings, history: {}, operate,
    pointColorRangeIndex: null, setPointColorRangeIndex: vi.fn(),
    beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
  function draw() { act(() => root.render(<RawAdjustmentControls raw={raw as never} />)); }
  const ranges = () => [...host.querySelectorAll<HTMLInputElement>('[data-adjustment-id^="vignette."]')];
  draw();
  expect(ranges().map(e => e.disabled)).toEqual([false, true, true, true, true]);
  expect(ranges().slice(1).every(e => e.closest('.adjustment-control')?.classList.contains('is-dependent-disabled'))).toBe(true);
  expect(ranges()[0].closest('.adjustment-control')?.classList.contains('is-dependent-disabled')).toBe(false);
  expect(host.querySelector('.raw-adjustment-subsection-header.is-vignette')).not.toBeNull();
  const radios = [...host.querySelectorAll<HTMLInputElement>('.raw-vignette-mode input')];
  expect(radios.map(e => e.value)).toEqual([...RAW_VIGNETTE_STYLES]);
  expect(radios.every(e => !e.disabled)).toBe(true);
  expect(radios.map(e => e.labels?.[0].textContent)).toEqual(language === 'ja' ? ['ハイライト', 'カラー', 'ペイント'] : ['Highlight', 'Color', 'Paint']);
  act(() => radios[0].click()); expect(operate).not.toHaveBeenCalled();
  act(() => radios[2].click()); expect(operate).toHaveBeenLastCalledWith({ kind: 'vignetteStyle', metadata: { style: 'paintOverlay' } });
  raw.desired = { 'vignette.amount': -1 }; draw();
  expect(ranges().every(e => !e.disabled)).toBe(true);
  expect(ranges().every(e => !e.closest('.adjustment-control')?.classList.contains('is-dependent-disabled'))).toBe(true);
  settings.vignetteStyle = 'colorPriority'; draw(); expect(ranges()[4].disabled).toBe(false);
  settings.values['vignette.amount'] = -50; raw.desired = { 'vignette.amount': 0 }; draw();
  expect(ranges().slice(1).every(e => e.disabled)).toBe(true);
  expect(ranges().map(e => e.value)).toEqual(['0', '23', '87', '-34', '89']);
  settings.sections.effects = false; draw();
  expect(ranges().every(e => e.disabled)).toBe(true); expect(radios.every(e => e.disabled)).toBe(true);
  settings.sections.effects = true; raw.desired = {}; draw();
  expect(ranges().every(e => !e.disabled)).toBe(true);
  const vignetteReset = host.querySelector<HTMLButtonElement>('.raw-adjustment-subsection-header.is-vignette button')!;
  const effectsReset = host.querySelector<HTMLButtonElement>('.raw-adjustment-category.is-effects .raw-adjustment-subsection-header button')!;
  act(() => vignetteReset.click()); expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionReset', metadata: { section: 'vignette' } });
  act(() => effectsReset.click()); expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionReset', metadata: { section: 'effects' } });
  expect(host.textContent).not.toContain('workspace.');
  expect(host.querySelectorAll('.raw-adjustment-subcategory-divider')).toHaveLength(2);
});
