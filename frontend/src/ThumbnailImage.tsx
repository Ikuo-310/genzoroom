import { useEffect, useRef, type ImgHTMLAttributes, type SyntheticEvent } from 'react';
import { frontendLogger } from './frontendLogging';
import { thumbnailDiagnosticUrl } from './thumbnailUrl';

type ThumbnailMode = 'original' | 'rendered' | 'preview';

type ThumbnailImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onLoad' | 'onError'> & {
  src: string;
  assetId: string;
  surface: string;
  mode: ThumbnailMode;
  onLoad?: ImgHTMLAttributes<HTMLImageElement>['onLoad'];
  onError?: ImgHTMLAttributes<HTMLImageElement>['onError'];
};

function log(input: Parameters<typeof frontendLogger.add>[0]) {
  try { frontendLogger.add(input); } catch { /* Diagnostics must never affect image delivery. */ }
}

function traceId(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

export function ThumbnailImage({ src, assetId, surface, mode, onLoad, onError, ...imageProps }: ThumbnailImageProps) {
  const diagnosticId = useRef(traceId()).current;
  const requestSrc = thumbnailDiagnosticUrl(src, diagnosticId);
  const startedAt = useRef(0);
  const settled = useRef(false);

  useEffect(() => {
    if (frontendLogger.getLevel() !== 'debug') return;
    startedAt.current = performance.now();
    settled.current = false;
    log({ level: 'debug', component: 'thumbnail', event: 'image.sourceAssigned',
      context: { diagnosticId, assetId, surface, mode } });
    return () => {
      if (!settled.current && frontendLogger.getLevel() === 'debug') {
        log({ level: 'debug', component: 'thumbnail', event: 'image.elementReleased',
          context: { diagnosticId, assetId, surface, mode } });
      }
    };
  }, [assetId, diagnosticId, mode, requestSrc, surface]);

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    settled.current = true;
    const image = event.currentTarget;
    if (frontendLogger.getLevel() === 'debug') log({ level: 'debug',
      component: 'thumbnail', event: 'image.loaded', context: { diagnosticId, assetId, surface, mode,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null } });
    onLoad?.(event);
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    settled.current = true;
    const image = event.currentTarget;
    log({ level: 'warn', component: 'thumbnail', event: 'image.loadFailed', context: {
      diagnosticId, assetId, surface, mode, complete: image.complete, naturalWidth: image.naturalWidth,
      durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null,
    } });
    onError?.(event);
  };

  return <img {...imageProps} src={requestSrc} onLoad={handleLoad} onError={handleError} />;
}
