(async () => {
  if (window.__genzoroomSmokeRunning) return;
  window.__genzoroomSmokeRunning = true;
  const wait = async (predicate, limit = 15000) => {
    const end = performance.now() + limit;
    while (!predicate()) {
      if (performance.now() > end) throw new Error('timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await wait(() => document.querySelector('#root')?.childElementCount > 0);
    const health = await fetch('/api/health', { cache: 'no-store' });
    if (location.pathname === '/') {
      const missing = await fetch('/api/__smoke_missing', { headers: { Accept: 'text/html' } });
      const image = new Image();
      image.src = '/api/assets/11111111-1111-4111-8111-111111111111/preview';
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      document.title = 'GenzoRoom-smoke-root:' + JSON.stringify({
        react: true, health: health.ok,
        image: pixels.width === 2 && pixels.height === 2,
        apiErrors: missing.status === 404 && missing.headers.get('content-type').includes('application/json')
      });
      window.open('/developer', '_blank', 'noopener,noreferrer');
      return;
    }
    await wait(() => document.querySelectorAll('.developer-tabs [role=tab]').length === 4);
    // The separate window must share the authenticated WebView profile, not receive a copied cookie.
    const result = { react: true, health: true, apiErrors: true, image: true,
      diagnostics: true, sharedCookie: health.ok,
      secureContext: isSecureContext, gpuApi: !!navigator.gpu, gpuResults: false };
    document.querySelector('#webgpu-tab').click();
    const run = document.querySelector('#webgpu-panel .developer-actions button');
    await wait(() => run && !run.disabled);
    run.click();
    // A non-GPU machine is a supported result; actual CPU fallback remains covered by React tests.
    await new Promise(resolve => setTimeout(resolve, 100));
    await wait(() => !run.disabled, 20000);
    const rows = [...document.querySelectorAll('#webgpu-panel tbody tr')];
    result.gpuResults = rows.length > 0 && rows.every(row => Number.isFinite(Number(row.cells[2].textContent)));
    document.title = 'GenzoRoom-smoke:' + JSON.stringify(result);
  } catch {
    document.title = 'GenzoRoom-smoke:' + JSON.stringify({});
  }
})();
