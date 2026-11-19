import { useEffect, useRef, useState, type ImgHTMLAttributes, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { frontendLogger } from './frontendLogging';
import { thumbnailDiagnosticUrl, thumbnailSourceUrl, type ThumbnailRendition } from './thumbnailUrl';

type ThumbnailMode = 'original' | 'rendered' | 'preview';
type ThumbnailPhase = 'loading' | 'loaded' | 'failed';

type ThumbnailImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onLoad' | 'onError'> & {
  src?: string;
  rendition?: ThumbnailRendition;
  revision?: string;
  assetId: string;
  surface: string;
  mode: ThumbnailMode;
  /** Asset publication identity reserved for P5; it invalidates only this Asset's image element. */
  publicationVersion?: string | number | null;
  onLoad?: ImgHTMLAttributes<HTMLImageElement>['onLoad'];
  onError?: ImgHTMLAttributes<HTMLImageElement>['onError'];
};

type RequestIdentity = { key: string; diagnosticId: string };

const failedImage = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" fill="%23101113"/%3E%3Cpath d="M45 27a15 15 0 1 0 2 11M45 17v11H34" fill="none" stroke="%23a5a5a8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/%3E%3C/svg%3E';

function log(input: Parameters<typeof frontendLogger.add>[0]) {
  try { frontendLogger.add(input); } catch { /* Diagnostics must never affect image delivery. */ }
}

function traceId(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function isDebugLogging(): boolean {
  try { return frontendLogger.getLevel() === 'debug'; } catch { return false; }
}

export function ThumbnailImage({ src, rendition, revision, assetId, surface, mode, publicationVersion, onLoad, onError, ...imageProps }: ThumbnailImageProps) {
  const { t } = useTranslation();
  const resolvedSrc = src ?? thumbnailSourceUrl(assetId, rendition ?? (mode === 'preview' ? 'preview' : 'thumbnail'), revision);
  const [attempt, setAttempt] = useState(0);
  const [phaseState, setPhaseState] = useState<{ key: string; phase: ThumbnailPhase } | null>(null);
  const requestKey = JSON.stringify([assetId, resolvedSrc, publicationVersion ?? null, attempt]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const activeRequestKey = useRef(requestKey);
  activeRequestKey.current = requestKey;
  const identityRef = useRef<RequestIdentity>({ key: '', diagnosticId: '' });
  if (identityRef.current.key !== requestKey) identityRef.current = { key: requestKey, diagnosticId: traceId() };
  const { diagnosticId } = identityRef.current;
  const requestSrc = thumbnailDiagnosticUrl(resolvedSrc, diagnosticId);
  const phase = phaseState?.key === requestKey ? phaseState.phase : 'loading';
  const startedAt = useRef(0);
  const settled = useRef(false);

  useEffect(() => {
    if (!isDebugLogging()) return;
    startedAt.current = performance.now();
    settled.current = false;
    log({ level: 'debug', component: 'thumbnail', event: 'image.sourceAssigned',
      context: { diagnosticId, assetId, surface, mode, attempt, publicationVersion: publicationVersion ?? null } });
    return () => {
      if (!settled.current && isDebugLogging()) {
        log({ level: 'debug', component: 'thumbnail', event: 'image.elementReleased',
          context: { diagnosticId, assetId, surface, mode } });
      }
    };
  }, [assetId, attempt, diagnosticId, mode, publicationVersion, requestKey, surface]);

  const isCurrentRequest = () => mountedRef.current && activeRequestKey.current === requestKey;
  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!isCurrentRequest() || phase === 'failed') return;
    settled.current = true;
    setPhaseState({ key: requestKey, phase: 'loaded' });
    const image = event.currentTarget;
    if (isDebugLogging()) log({ level: 'debug',
      component: 'thumbnail', event: 'image.loaded', context: { diagnosticId, assetId, surface, mode,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null } });
    onLoad?.(event);
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!isCurrentRequest()) return;
    settled.current = true;
    setPhaseState({ key: requestKey, phase: 'failed' });
    const image = event.currentTarget;
    log({ level: 'warn', component: 'thumbnail', event: 'image.loadFailed', context: {
      diagnosticId, assetId, surface, mode, attempt, complete: image.complete, naturalWidth: image.naturalWidth,
      durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null,
    } });
    onError?.(event);
  };

  const retry = () => {
    if (phase !== 'failed') return;
    log({ level: 'info', component: 'thumbnail', event: 'image.retryRequested', context: { assetId, surface, mode, attempt: attempt + 1 } });
    setPhaseState(null);
    setAttempt(value => value + 1);
  };
  const handleRetryClick = (event: MouseEvent<HTMLImageElement>) => {
    if (phase !== 'failed') return;
    event.preventDefault();
    event.stopPropagation();
    retry();
  };
  const handleRetryKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
    if (phase !== 'failed' || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    retry();
  };

  return <img key={requestKey} src={phase === 'failed' ? failedImage : requestSrc} alt={imageProps.alt} {...imageProps}
    data-thumbnail-state={phase} aria-busy={phase === 'loading' ? true : undefined}
    role={phase === 'failed' ? 'button' : undefined} tabIndex={phase === 'failed' ? 0 : imageProps.tabIndex}
    aria-label={phase === 'failed' ? t('thumbnail.retry') : imageProps['aria-label']}
    title={phase === 'failed' ? t('thumbnail.retry') : imageProps.title}
    className={`${imageProps.className ?? ''}${phase === 'failed' ? ' thumbnail-image-failed' : ''}`.trim() || undefined}
    onClick={handleRetryClick} onKeyDown={handleRetryKeyDown} onLoad={handleLoad} onError={handleError} />;
}
