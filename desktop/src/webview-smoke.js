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
      const events = [];
      let documentEvents = 0;
      const record = event => {
        if (event.key.toLowerCase() === 'a' || event.code === 'KeyA') events.push({ type: event.type, key: event.key, code: event.code,
          ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey,
          body: event.target === document.body && document.activeElement === document.body });
      };
      const recordDocument = event => { if (event.code === 'KeyA') documentEvents++; };
      window.addEventListener('keydown', record, true);
      window.addEventListener('keyup', record, true);
      document.addEventListener('keydown', recordDocument);
      document.addEventListener('keyup', recordDocument);
      document.body.tabIndex = -1;
      document.body.focus();
      // Synthetic DOM events check React guards in WebView2; they do not prove OS input delivery.
      const key = (ctrl, target = document.body) => {
        const init = { key: 'a', code: 'KeyA', ctrlKey: ctrl, bubbles: true, cancelable: true };
        const down = new KeyboardEvent('keydown', init);
        target.dispatchEvent(down); target.dispatchEvent(new KeyboardEvent('keyup', init));
        return down.defaultPrevented;
      };
      const plainHandled = key(false);
      await wait(() => document.querySelector('#home-albums-tab')?.getAttribute('aria-selected') === 'true');
      key(true);
      const simpleShortcut = document.querySelector('#home-albums-tab')?.getAttribute('aria-selected') === 'true';
      const input = document.createElement('input');
      input.value = 'keyboard-fixture'; document.body.append(input); input.focus(); input.setSelectionRange(4, 4);
      const inputHandled = key(true, input);
      const result = {
        domDown: events.filter(event => event.type === 'keydown').length === 3,
        domUp: events.filter(event => event.type === 'keyup').length === 3,
        documentEvents: documentEvents === 6,
        keyCode: events.every(event => event.key === 'a' && event.code === 'KeyA'),
        modifiers: events.slice(0, 2).every(event => !event.ctrl && !event.alt && !event.meta && !event.shift)
          && events.slice(2).every(event => event.ctrl && !event.alt && !event.meta && !event.shift),
        targetFocus: events.slice(0, 4).every(event => event.body),
        simpleShortcut: simpleShortcut && plainHandled, inputGuard: !inputHandled && document.activeElement === input
          && document.querySelector('#home-albums-tab')?.getAttribute('aria-selected') === 'true'
      };
      window.removeEventListener('keydown', record, true); window.removeEventListener('keyup', record, true);
      document.removeEventListener('keydown', recordDocument); document.removeEventListener('keyup', recordDocument);
      input.remove(); document.body.removeAttribute('tabindex');
      document.title = 'GenzoRoom-keyboard:' + JSON.stringify(result);
      await wait(() => typeof window.__genzoroomKeyboardPassed === 'boolean');
      if (!window.__genzoroomKeyboardPassed) throw new Error('keyboard_failed');
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
