import { useEffect, useRef, useState } from 'react';
import type { AssetDetail } from './assets';
import { readJpegProfile, type JpegProfile } from './jpegProfile';
import { getEditImageSource, type EditImageSource } from './editImageSource';

type Original = { assetId: string; status: 'loading' | 'ready' | 'error'; url?: string; profile: JpegProfile };

export function useJpegOriginal(asset: AssetDetail | null) {
  const assetId = asset?.format === 'JPEG' ? asset.id : null;
  const [original, setOriginal] = useState<Original | null>(null);
  const [mode, setMode] = useState<{ assetId: string; original: boolean } | null>(null);
  const releaseOriginal = useRef(() => {});
  useEffect(() => {
    setMode(null);
    setOriginal(null);
    if (!assetId) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const release = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    };
    releaseOriginal.current = release;
    setOriginal({ assetId, status: 'loading', profile: { status: 'unknown' } });
    void (async () => {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/original`, { signal: controller.signal, cache: 'no-store' });
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error('JPEG original unavailable');
      const blob = await response.blob();
      const profile = await readJpegProfile(blob, controller.signal);
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setOriginal({ assetId, status: 'ready', url: objectUrl, profile });
    })().catch(() => {
      if (!controller.signal.aborted) setOriginal({ assetId, status: 'error', profile: { status: 'unknown' } });
    });
    return () => {
      controller.abort();
      release();
    };
  }, [assetId]);
  // Gate on identity during render: effect cleanup alone is too late on navigation.
  const current = original?.assetId === assetId ? original : null;
  const showingOriginal = mode?.assetId === assetId && mode.original && current?.status === 'ready';
  const source: EditImageSource | undefined = asset ? showingOriginal
    ? { kind: 'jpeg-original', url: current.url! } : getEditImageSource(asset) : undefined;
  return {
    source, showingOriginal: !!showingOriginal, status: assetId ? current?.status ?? 'loading' : undefined,
    profile: current?.profile ?? { status: 'unknown' } as JpegProfile,
    toggle: () => { if (assetId && current?.status === 'ready') setMode({ assetId, original: !showingOriginal }); },
    failDecode: () => {
      if (assetId && showingOriginal) {
        releaseOriginal.current();
        setMode(null);
        setOriginal({ ...current!, status: 'error', url: undefined });
      }
    },
  };
}
