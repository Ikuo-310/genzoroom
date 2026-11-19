import { useEffect, useRef, useState, type ImgHTMLAttributes, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
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
const clickSequenceWindowMs = 500;

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

export function isThumbnailRetryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-thumbnail-retry]') !== null;
}

function focusThumbnailAction(host: HTMLElement | null) {
  if (!host) return;
  const target = host.querySelector<HTMLElement>('[data-thumbnail-action]') ?? host;
  target.focus({ preventScroll: true });
}

function restoreCardFocus(host: HTMLElement | null, retryButton: HTMLButtonElement | null) {
  if (!host || !retryButton || host.ownerDocument.activeElement !== retryButton) return;
  focusThumbnailAction(host);
}

export function ThumbnailImage({ src, rendition, revision, assetId, surface, mode, publicationVersion, onLoad, onError, ...imageProps }: ThumbnailImageProps) {
  const { t } = useTranslation();
  const resolvedSrc = src ?? thumbnailSourceUrl(assetId, rendition ?? (mode === 'preview' ? 'preview' : 'thumbnail'), revision);
  const sourceKey = JSON.stringify([assetId, resolvedSrc, publicationVersion ?? null]);
  const [attempt, setAttempt] = useState(0);
  const [phaseState, setPhaseState] = useState<{ key: string; phase: ThumbnailPhase } | null>(null);
  const [retryControl, setRetryControl] = useState<{ sourceKey: string; visible: boolean } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const [retryHost, setRetryHost] = useState<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const hideRetryTimer = useRef<number | null>(null);
  const previousSourceKey = useRef(sourceKey);
  const restoreFocusAfterSourceChange = useRef(false);
  const requestKey = JSON.stringify([sourceKey, attempt]);
  const activeRequestKey = useRef(requestKey);
  activeRequestKey.current = requestKey;
  if (previousSourceKey.current !== sourceKey) {
    restoreFocusAfterSourceChange.current = typeof document !== 'undefined'
      && document.activeElement === retryButtonRef.current;
    previousSourceKey.current = sourceKey;
  }
  const identityRef = useRef<RequestIdentity>({ key: '', diagnosticId: '' });
  if (identityRef.current.key !== requestKey) identityRef.current = { key: requestKey, diagnosticId: traceId() };
  const { diagnosticId } = identityRef.current;
  const requestSrc = thumbnailDiagnosticUrl(resolvedSrc, diagnosticId);
  const phase = phaseState?.key === requestKey ? phaseState.phase : 'loading';
  const latestPhase = useRef<ThumbnailPhase>(phase);
  latestPhase.current = phase;
  const showRetry = retryControl?.sourceKey === sourceKey && retryControl.visible;
  const startedAt = useRef(0);
  const settled = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const host = imageRef.current?.closest<HTMLElement>('[data-thumbnail-retry-host]') ?? null;
    setRetryHost(host);
    return () => {
      mountedRef.current = false;
      if (hideRetryTimer.current !== null) window.clearTimeout(hideRetryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (hideRetryTimer.current !== null) window.clearTimeout(hideRetryTimer.current);
    if (restoreFocusAfterSourceChange.current) {
      focusThumbnailAction(retryHost);
      restoreFocusAfterSourceChange.current = false;
    }
    setRetryControl(current => current?.sourceKey === sourceKey ? current : null);
  }, [retryHost, sourceKey]);

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
    if (isDebugLogging()) log({ level: 'debug', component: 'thumbnail', event: 'image.loaded',
      context: { diagnosticId, assetId, surface, mode, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null } });
    onLoad?.(event);
    if (showRetry) {
      const host = retryHost;
      const button = retryButtonRef.current;
      if (host?.ownerDocument.activeElement === button) {
        (host.querySelector<HTMLElement>('[data-thumbnail-action]') ?? host).focus({ preventScroll: true });
      }
    }
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!isCurrentRequest()) return;
    settled.current = true;
    setPhaseState({ key: requestKey, phase: 'failed' });
    setRetryControl({ sourceKey, visible: true });
    const image = event.currentTarget;
    log({ level: 'warn', component: 'thumbnail', event: 'image.loadFailed', context: {
      diagnosticId, assetId, surface, mode, attempt, complete: image.complete, naturalWidth: image.naturalWidth,
      durationMs: startedAt.current ? Math.round(performance.now() - startedAt.current) : null,
    } });
    onError?.(event);
  };

  const retry = () => {
    if (!isCurrentRequest() || phase !== 'failed') return;
    log({ level: 'info', component: 'thumbnail', event: 'image.retryRequested', context: { assetId, surface, mode, attempt: attempt + 1 } });
    setPhaseState(null);
    setRetryControl({ sourceKey, visible: true });
    setAttempt(value => value + 1);
    const retryRequestKey = JSON.stringify([sourceKey, attempt + 1]);
    if (hideRetryTimer.current !== null) window.clearTimeout(hideRetryTimer.current);
    hideRetryTimer.current = window.setTimeout(() => {
      if (activeRequestKey.current !== retryRequestKey || latestPhase.current === 'failed') return;
      restoreCardFocus(retryHost, retryButtonRef.current);
      setRetryControl(current => current?.sourceKey === sourceKey ? { sourceKey, visible: false } : current);
      hideRetryTimer.current = null;
    }, clickSequenceWindowMs);
  };

  const handleRetryClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 1 || phase !== 'failed') return;
    event.currentTarget.focus({ preventScroll: true });
    retry();
  };
  const handleRetryDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const handleRetryKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (phase === 'failed') retry();
  };
  const handleRetryKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return <>
    <img {...imageProps} ref={imageRef} key={requestKey} src={phase === 'failed' ? failedImage : requestSrc} alt={imageProps.alt}
      data-thumbnail-state={phase} aria-busy={phase === 'loading' ? true : undefined}
      className={`${imageProps.className ?? ''}${phase === 'failed' ? ' thumbnail-image-failed' : ''}`.trim() || undefined}
      onLoad={handleLoad} onError={handleError} />
    {showRetry && retryHost && createPortal(<button ref={retryButtonRef} type="button" className="thumbnail-retry-control"
      data-thumbnail-retry data-thumbnail-surface={surface} aria-label={t(phase === 'failed' ? 'thumbnail.retry' : 'thumbnail.retrying')}
      title={t(phase === 'failed' ? 'thumbnail.retry' : 'thumbnail.retrying')} aria-disabled={phase !== 'failed'} tabIndex={0}
      onClick={handleRetryClick} onDoubleClick={handleRetryDoubleClick}
      onKeyDown={handleRetryKeyDown} onKeyUp={handleRetryKeyUp} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
      <span aria-hidden="true">↻</span>
    </button>, retryHost)}
  </>;
}
