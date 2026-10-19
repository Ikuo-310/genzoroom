// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadJsonReport } from './jsonReportDownload';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['saved', 'cancelled', 'failed'])('waits for WebView2 completion and treats %s correctly', async status => {
  vi.useFakeTimers();
  vi.stubGlobal('__GENZOROOM_REPORT_DOWNLOAD__', true);
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:report', revokeObjectURL: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  let settled = false;
  const pending = downloadJsonReport({ generatedAt: '2026-10-19T00:00:00.000Z', text: '日本語' }, 'genzoroom-diagnostics');
  const checked = pending.then(() => { settled = true; return 'ok'; }, () => { settled = true; return 'failed'; });
  await Promise.resolve();
  expect(settled).toBe(false);
  window.dispatchEvent(new CustomEvent('genzoroom:report-download', { detail: { url: 'blob:other', status } }));
  await Promise.resolve(); expect(settled).toBe(false);
  window.dispatchEvent(new CustomEvent('genzoroom:report-download', { detail: { url: 'blob:report', status } }));
  expect(await checked).toBe(status === 'failed' ? 'failed' : 'ok');
  expect(document.querySelector('a')).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers(); expect(revoke).toHaveBeenCalledWith('blob:report');
});
