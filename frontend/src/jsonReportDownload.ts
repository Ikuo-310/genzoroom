export function downloadJsonReport(report: { generatedAt: string }, prefix: string): void {
  const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${prefix}-${report.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    // Defer revocation until the browser has consumed the download gesture.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

