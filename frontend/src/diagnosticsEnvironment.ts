export interface DiagnosticsEnvironment {
  secureContext: boolean | null;
  crossOriginIsolated: boolean | null;
  gpuApiAvailable: boolean;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  devicePixelRatio: number | null;
  viewport: { width: number | null; height: number | null };
  userAgent: string | null;
  platform: string | null;
}

export interface BrowserDiagnosticsInfo {
  name: 'Chrome' | 'Chromium' | 'Edge' | 'Firefox' | 'Opera' | 'Safari' | 'Samsung Internet' | 'unknown';
  version: string | null;
  os: 'Android' | 'ChromeOS' | 'iOS' | 'Linux' | 'macOS' | 'Windows' | 'unknown';
  secureContext: boolean | null;
  crossOriginIsolated: boolean | null;
  webGpuApiAvailable: boolean;
}

function read<T>(get: () => unknown, accepts: (value: unknown) => value is T): T | null {
  try { const value = get(); return accepts(value) ? value : null; } catch { return null; }
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';

export function collectDiagnosticsEnvironment(browser: Window = window, agent: Navigator = navigator): DiagnosticsEnvironment {
  // Keep the established diagnostic snapshot intact; browser metadata below is a privacy-filtered projection.
  return {
    secureContext: read(() => browser.isSecureContext, boolean),
    crossOriginIsolated: read(() => browser.crossOriginIsolated, boolean),
    gpuApiAvailable: read(() => Boolean((agent as Navigator & { gpu?: unknown }).gpu), boolean) ?? false,
    hardwareConcurrency: read(() => agent.hardwareConcurrency, number),
    deviceMemory: read(() => (agent as Navigator & { deviceMemory?: number }).deviceMemory, number),
    devicePixelRatio: read(() => browser.devicePixelRatio, number),
    viewport: { width: read(() => browser.innerWidth, number), height: read(() => browser.innerHeight, number) },
    userAgent: read(() => agent.userAgent, string),
    platform: read(() => agent.platform, string),
  };
}

function browserIdentity(userAgent: string | null, platform: string | null): Pick<BrowserDiagnosticsInfo, 'name' | 'version' | 'os'> {
  const agent = userAgent?.slice(0, 1024) ?? '';
  const browserPatterns: Array<[BrowserDiagnosticsInfo['name'], RegExp]> = [
    ['Edge', /(?:Edg|EdgA|EdgiOS)\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Chromium', /Chromium\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari\//],
  ];
  const match = browserPatterns.map(([name, pattern]) => ({ name, match: pattern.exec(agent) }))
    .find(candidate => candidate.match !== null);
  const osAgent = agent.toLowerCase();
  const osPlatform = (platform ?? '').toLowerCase();
  let os: BrowserDiagnosticsInfo['os'] = 'unknown';
  if (/\bcros\b/.test(osAgent)) os = 'ChromeOS';
  else if (/android/.test(osAgent) || /android/.test(osPlatform)) os = 'Android';
  else if (/iphone|ipad|ipod/.test(osAgent) || /^(iphone|ipad|ipod)/.test(osPlatform)) os = 'iOS';
  else if (/windows nt/.test(osAgent) || /^win/.test(osPlatform)) os = 'Windows';
  else if (/macintosh|mac os x/.test(osAgent) || /^(mac|darwin)/.test(osPlatform)) os = 'macOS';
  else if (/linux|x11/.test(osAgent) || /linux/.test(osPlatform)) os = 'Linux';
  return { name: match?.name ?? 'unknown', version: match?.match?.[1] ?? null, os };
}

export function createBrowserDiagnosticsInfo(environment: DiagnosticsEnvironment): BrowserDiagnosticsInfo {
  const identity = browserIdentity(
    typeof environment.userAgent === 'string' ? environment.userAgent : null,
    typeof environment.platform === 'string' ? environment.platform : null,
  );
  return {
    ...identity,
    secureContext: typeof environment.secureContext === 'boolean' ? environment.secureContext : null,
    crossOriginIsolated: typeof environment.crossOriginIsolated === 'boolean' ? environment.crossOriginIsolated : null,
    webGpuApiAvailable: environment.gpuApiAvailable === true,
  };
}

export function collectBrowserDiagnosticsInfo(): BrowserDiagnosticsInfo {
  return createBrowserDiagnosticsInfo(collectDiagnosticsEnvironment());
}
