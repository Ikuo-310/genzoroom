// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRawCapability } from './useRawCapability';
import { ANSHITSU_INITIAL_SELECTION_KEY, effectiveAnshitsuSelection, readSettings, updateSetting, useAppSettings } from './appSettings';

let root: Root, host: HTMLDivElement;
let snapshot: { saved: string; effective: string; available: boolean };
function Harness() {
  const settings = useAppSettings(), available = useRawCapability();
  snapshot = { saved: settings.anshitsuInitialSelection, effective: effectiveAnshitsuSelection(settings.anshitsuInitialSelection, available), available };
  return null;
}
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
function response(available: boolean) { return new Response(JSON.stringify({ available, version: '0.14.0' }), { headers: { 'Content-Type': 'application/json' } }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); root = createRoot(host); localStorage.clear(); updateSetting('anshitsuInitialSelection', 'raw');
});
afterEach(() => { act(() => root.unmount()); updateSetting('anshitsuInitialSelection', 'nonRaw'); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('locks before capability, restores the saved RAW preset on Windows recovery, and never rewrites it', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(yes => { resolve = yes; });
  const fetch = vi.fn().mockReturnValueOnce(pending).mockImplementation(async () => response(false));
  vi.stubGlobal('fetch', fetch);
  act(() => root.render(<Harness />)); expect(snapshot).toEqual({ saved: 'raw', effective: 'nonRaw', available: false });
  resolve(response(true)); await flush(); expect(snapshot.effective).toBe('raw');
  await act(async () => vi.advanceTimersByTimeAsync(15_000)); expect(snapshot.effective).toBe('nonRaw');
  expect(localStorage.getItem(ANSHITSU_INITIAL_SELECTION_KEY)).toBe('raw'); expect(readSettings().anshitsuInitialSelection).toBe('raw');
  fetch.mockImplementation(async () => response(true));
  await act(async () => vi.advanceTimersByTimeAsync(15_000)); expect(snapshot.effective).toBe('raw');
  act(() => updateSetting('anshitsuInitialSelection', 'both')); expect(snapshot.effective).toBe('both');
});

it('keeps Docker presets locked with the stored Both value intact when the RAW route is absent', async () => {
  updateSetting('anshitsuInitialSelection', 'both');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
  act(() => root.render(<Harness />)); await flush();
  expect(snapshot).toEqual({ saved: 'both', effective: 'nonRaw', available: false });
  expect(localStorage.getItem(ANSHITSU_INITIAL_SELECTION_KEY)).toBe('both');
});
