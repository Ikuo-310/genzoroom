// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawAdjustmentControls } from './RawAdjustmentControls';
import { rawSettings } from './test/rawSettings';
import { RAW_VIGNETTE_STYLES } from './rawApi';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it.each(['ja', 'en'])('uses desired amount for dependents and preserves values/mode while inactive in %s', async language => {
  await i18n.changeLanguage(language);
  const settings = rawSettings({ workspaceId: 'workspace', assetId: 'asset', handle: 'handle', documentToken: 'token', generation: 1, revision: 1 });
  Object.assign(settings.values, { 'vignette.midpoint': 23, 'vignette.feather': 87, 'vignette.roundness': -34, 'vignette.highlights': 89 });
  const operate = vi.fn();
  const raw = { assetId: 'asset', status: 'ready', settings, history: {}, operate, beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
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
  const resets = [...host.querySelectorAll<HTMLButtonElement>('.raw-adjustment-subsection-header button')];
  act(() => resets[1].click()); expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionReset', metadata: { section: 'vignette' } });
  act(() => resets[0].click()); expect(operate).toHaveBeenLastCalledWith({ kind: 'sectionReset', metadata: { section: 'effects' } });
  expect(host.textContent).not.toContain('workspace.');
  expect(host.querySelectorAll('.raw-adjustment-subcategory-divider')).toHaveLength(1);
});
