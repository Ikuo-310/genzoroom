import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAssetDetail } from './api';
import type { AssetExif, RecentAsset } from './assets';
import { detectStackCandidates, stackCandidateDetailTargets } from './stackCandidateDetection';

const DETAIL_CONCURRENCY = 4;

export function useStackCandidateDetection(assets: readonly RecentAsset[]) {
  const [result, setResult] = useState(() => detectStackCandidates(assets));
  // Membership can replace inputs before the effect runs; never authorize editing the preceding result.
  const [resultAssets, setResultAssets] = useState(assets);
  const [loading, setLoading] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const [detailCount, setDetailCount] = useState(0);
  const request = useRef<{ generation: number; controller: AbortController | null; busy: boolean }>({ generation: 0, controller: null, busy: false });

  const detect = useCallback(() => {
    const current = request.current;
    current.controller?.abort();
    const generation = ++current.generation;
    const controller = new AbortController();
    current.controller = controller;
    const snapshot = [...new Map(assets.map(asset => [asset.id, asset])).values()];
    const initial = detectStackCandidates(snapshot);
    const candidates = stackCandidateDetailTargets(snapshot);
    current.busy = candidates.length > 0;
    setResult(initial);
    setResultAssets(assets);
    setFailureCount(0);
    setDetailCount(candidates.length);
    setLoading(current.busy);
    if (!candidates.length) return;
    const details = new Map<string, AssetExif>();
    const failures = new Set<string>();
    let nextIndex = 0;
    const isCurrent = () => !controller.signal.aborted && request.current.generation === generation;
    const worker = async () => {
      while (isCurrent() && nextIndex < candidates.length) {
        const asset = candidates[nextIndex++];
        try {
          const detail = await fetchAssetDetail(asset.id, controller.signal);
          if (!isCurrent()) return;
          if (detail.id !== asset.id || !detail.exif || typeof detail.exif !== 'object' || Array.isArray(detail.exif)) {
            throw new Error('Unusable asset detail');
          }
          details.set(asset.id, detail.exif);
        } catch {
          if (!isCurrent()) return;
          failures.add(asset.id);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, candidates.length) }, worker)).then(() => {
      // Abort is advisory: even a transport that resolves late must not publish stale evidence.
      if (!isCurrent()) return;
      setResult(detectStackCandidates(snapshot, details, failures));
      setFailureCount(failures.size);
      setLoading(false);
      request.current.busy = false;
    });
  }, [assets]);

  useEffect(() => {
    detect();
    return () => {
      request.current.controller?.abort();
      request.current.generation++;
      request.current.busy = false;
    };
  }, [detect]);

  const redetect = () => {
    // Guard the synchronous click interval before React commits the disabled button.
    if (!request.current.busy) detect();
  };
  return { ...result, loading: loading || resultAssets !== assets, failureCount, detailCount, redetect };
}
