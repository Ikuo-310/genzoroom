import { BUILD_INFO } from './buildInfo';
import { downloadJsonReport } from './jsonReportDownload';
import { collectBrowserDiagnosticsInfo, createBrowserDiagnosticsInfo, type DiagnosticsEnvironment } from './diagnosticsEnvironment';

export type DiagnosticErrorCode = 'configuration_missing' | 'immich_url_missing' | 'immich_api_key_missing'
  | 'unreachable' | 'authentication_failed' | 'unexpected_response' | 'backend_unreachable' | 'backend_request_failed';
export interface ImmichDiagnosticInfo {
  status: 'ok' | 'error'; version: string | null; build: string | null; sourceRef: string | null; errorCode: DiagnosticErrorCode | null;
}

const IMMICH_ERRORS = new Set<string>([
  'configuration_missing', 'immich_url_missing', 'immich_api_key_missing', 'unreachable',
  'authentication_failed', 'unexpected_response',
]);
let exportInFlight = false;

export class DiagnosticExportInProgressError extends Error {
  constructor() {
    super('A diagnostic export is already in progress');
    this.name = 'DiagnosticExportInProgressError';
  }
}

function normalizeImmich(value: unknown): ImmichDiagnosticInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'unexpected_response' };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.error_code === 'string' && IMMICH_ERRORS.has(body.error_code)) {
    return { status: 'error', version: null, build: null, sourceRef: null, errorCode: body.error_code as DiagnosticErrorCode };
  }
  if (typeof body.version !== 'string' || body.version.length > 200
    || ['build', 'sourceRef'].some(key => body[key] !== undefined && body[key] !== null
      && (typeof body[key] !== 'string' || body[key].length > 200))) {
    return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'unexpected_response' };
  }
  return {
    status: 'ok', version: body.version,
    build: typeof body.build === 'string' ? body.build : null,
    sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : null,
    errorCode: null,
  };
}

async function fetchImmichInfo(signal?: AbortSignal): Promise<ImmichDiagnosticInfo> {
  const controller = new AbortController();
  let timedOut = false;
  let leftPage = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8500);
  const abort = () => controller.abort();
  const leaving = () => { leftPage = true; controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  window.addEventListener('pagehide', leaving, { once: true });
  try {
    const response = await fetch('/api/immich/about', { signal: controller.signal, cache: 'no-store' });
    if (leftPage || signal?.aborted) throw new DOMException('Diagnostic export cancelled', 'AbortError');
    if (!response.ok) return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'backend_request_failed' };
    try { return normalizeImmich(await response.json()); }
    catch {
      if (timedOut) return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'backend_unreachable' };
      if (signal?.aborted || leftPage) throw new DOMException('Diagnostic export cancelled', 'AbortError');
      return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'unexpected_response' };
    }
  } catch {
    if ((signal?.aborted && !timedOut) || leftPage) throw new DOMException('Diagnostic export cancelled', 'AbortError');
    return { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'backend_unreachable' };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    window.removeEventListener('pagehide', leaving);
  }
}

export async function downloadDiagnosticJson<T extends { generatedAt: string }>(report: T, prefix: string, signal?: AbortSignal,
  options: { includeBrowser?: boolean } = {}): Promise<void> {
  // A resolved no-op would make callers report a skipped export as successful.
  if (exportInFlight) throw new DiagnosticExportInProgressError();
  exportInFlight = true;
  try {
    // Reports are copied at the click boundary; diagnostics continuing during the request cannot alter this export.
    const snapshot = JSON.parse(JSON.stringify(report)) as Record<string, unknown> & { generatedAt: string };
    const immich = await fetchImmichInfo(signal);
    if (signal?.aborted) throw new DOMException('Diagnostic export cancelled', 'AbortError');
    const environment = snapshot.environment as DiagnosticsEnvironment | undefined;
    const browser = options.includeBrowser === false ? undefined
      : environment ? createBrowserDiagnosticsInfo(environment) : collectBrowserDiagnosticsInfo();
    downloadJsonReport({ ...snapshot, schemaVersion: 2, application: { ...BUILD_INFO }, immich,
      ...(browser ? { browser } : {}) }, prefix);
  } finally { exportInFlight = false; }
}
