declare global { interface Window { __GENZOROOM_REPORT_DOWNLOAD__?: boolean } }

export async function downloadJsonReport<T extends { generatedAt: string }>(report: T, prefix: string): Promise<void> {
  const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${prefix}-${report.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
  document.body.append(link);
  let dispose = () => {};
  try {
    if (window.__GENZOROOM_REPORT_DOWNLOAD__) {
      // The host owns the chooser; retain the Blob until WebView2 finishes reading it.
      await new Promise<void>((resolve, reject) => {
        const result = (event: Event) => {
          const detail = (event as CustomEvent).detail;
          if (detail?.url !== url) return;
          if (detail.status === 'saved' || detail.status === 'cancelled') resolve();
          else reject(new Error('report_download_failed'));
        };
        const leaving = () => reject(new DOMException('Page closed', 'AbortError'));
        dispose = () => {
          window.removeEventListener('genzoroom:report-download', result);
          window.removeEventListener('pagehide', leaving);
        };
        window.addEventListener('genzoroom:report-download', result);
        window.addEventListener('pagehide', leaving, { once: true });
        try { link.click(); } catch { reject(new Error('report_download_failed')); }
      });
    } else link.click();
  } finally {
    dispose();
    link.remove();
    // Defer revocation until the browser has consumed the download gesture.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

