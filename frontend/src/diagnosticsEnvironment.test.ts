import { expect, it } from 'vitest';
import { createBrowserDiagnosticsInfo } from './diagnosticsEnvironment';

const environment = (userAgent: string, platform: string | null = null) => ({
  secureContext: true,
  crossOriginIsolated: false,
  gpuApiAvailable: true,
  hardwareConcurrency: 8,
  deviceMemory: 4,
  devicePixelRatio: 1,
  viewport: { width: 800, height: 600 },
  userAgent,
  platform,
});

it.each([
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Win32', 'Edge', '131.0.0.0', 'Windows'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'MacIntel', 'Safari', '17.0', 'macOS'],
  ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/132.0', 'Linux x86_64', 'Firefox', '132.0', 'Linux'],
  ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36', 'Linux armv8l', 'Chrome', '131.0.0.0', 'Android'],
] as const)('identifies known browser and OS signatures without retaining the user agent', (userAgent, platform, name, version, os) => {
  const info = createBrowserDiagnosticsInfo(environment(userAgent, platform));
  expect(info).toEqual({ name, version, os, secureContext: true, crossOriginIsolated: false, webGpuApiAvailable: true });
  expect(JSON.stringify(info)).not.toContain(userAgent);
});

it('uses unknown values for unrecognized browser and OS data and exports no identifying strings', () => {
  const userAgent = 'PrivateBrowser/9.1 https://private.example token=secret';
  const info = createBrowserDiagnosticsInfo({
    ...environment(userAgent, 'unrecognized-platform'),
    secureContext: null,
    crossOriginIsolated: null,
    gpuApiAvailable: false,
  });
  expect(info).toEqual({ name: 'unknown', version: null, os: 'unknown', secureContext: null,
    crossOriginIsolated: null, webGpuApiAvailable: false });
  expect(JSON.stringify(info)).not.toMatch(/PrivateBrowser|private\.example|token|secret|https?:\/\//i);
});
