import { frontendLogger } from './frontendLogging';

function log(event: string, level: 'debug' | 'warn', assetId: string, reason: 'filmstrip' | 'exit', status?: number) {
  try {
    frontendLogger.add({ level, component: 'thumbnail', event, context: { assetId, reason,
      ...(status === undefined ? {} : { httpStatus: status }) } });
  } catch { /* Optional diagnostics must never block navigation. */ }
}

export function requestThumbnailGeneration(assetId: string, reason: 'filmstrip' | 'exit'): void {
  // This request belongs to the saved asset, not the mounted route; navigation must not abort or await it.
  void (async () => {
    log('requested', 'debug', assetId, reason);
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/rendered-thumbnail`, {
        method: 'POST', cache: 'no-store', keepalive: true,
      });
      log(response.ok ? 'accepted' : 'request.failed', response.ok ? 'debug' : 'warn', assetId, reason, response.status);
    } catch {
      log('request.failed', 'warn', assetId, reason);
    }
  })();
}
