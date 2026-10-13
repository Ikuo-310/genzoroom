import { useEffect, useRef, useState } from 'react';
import type { RecentAsset } from './assets';
import { exclusionConfirmed, exclusionKey, exclusionLog, exclusionTarget, getExclusionStatuses, saveExclusion, type ExclusionTarget } from './developmentExclusionsApi';

type Entry = { signature: string; excluded: boolean; generation: number; known: boolean };
export function useDevelopmentExclusions(assets: readonly RecentAsset[], context: string, source: readonly RecentAsset[] | undefined) {
  const targets = new Map<string, ExclusionTarget>();
  const conflicts = new Set<string>();
  const snapshotAssets = source ?? assets;
  const visibleKeys = new Set(assets.map(asset => exclusionKey({ kind: asset.stackId ? 'stack' : 'asset', id: asset.stackId ?? asset.id })));
  for (const asset of snapshotAssets) {
    const target = exclusionTarget(asset);
    if (!target) {
      if (asset.stackId) conflicts.add(exclusionKey({ kind: 'stack', id: asset.stackId }));
      continue;
    }
    const key = exclusionKey(target), previous = targets.get(key);
    if (previous && previous.signature !== target.signature) conflicts.add(key);
    targets.set(key, target);
  }
  // Collapse and filters must not hide conflicting ownership in the same Gallery snapshot.
  const owners = new Map<string, string>();
  for (const asset of snapshotAssets) {
    const key = exclusionKey({ kind: asset.stackId ? 'stack' : 'asset', id: asset.stackId ?? asset.id });
    const members = [asset.id, ...(asset.stackId ? [asset.primaryAssetId, ...(asset.stackMemberIds ?? [])] : [])];
    for (const member of members) {
      if (!member) continue;
      const id = member.toLowerCase(), previous = owners.get(id);
      if (previous && previous !== key) { conflicts.add(previous); conflicts.add(key); }
      owners.set(id, key);
    }
  }
  for (const key of targets.keys()) if (conflicts.has(key) || !visibleKeys.has(key)) targets.delete(key);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const pending = useRef(new Set<string>());
  const scopeKey = JSON.stringify([context, refreshRevision, [...targets].map(([key, t]) => [key, t.signature])]);
  const scope = useRef({ key: scopeKey, source, generation: 0 });
  if (scope.current.key !== scopeKey || scope.current.source !== source) {
    scope.current = { key: scopeKey, source, generation: scope.current.generation + 1 };
  }
  const generation = scope.current.generation;
  const [entries, setEntries] = useState(new Map<string, Entry>());
  const [failure, setFailure] = useState<{ generation: number; kind: 'loadFailed' | 'saveFailed' } | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const versions = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controllers.current.forEach(c => c.abort()); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const requested = [...targets.values()];
    const atStart = new Map(versions.current);
    setFailure(null);
    const timeout = window.setTimeout(() => {
      if (mounted.current && generation === scope.current.generation) setFailure({ generation, kind: 'loadFailed' });
      controller.abort();
    }, 15000);
    void (async () => {
      for (let offset = 0; offset < requested.length; offset += 100) {
        const batch = requested.slice(offset, offset + 100);
        try {
          const statuses = await getExclusionStatuses(batch, controller.signal);
          if (controller.signal.aborted || !mounted.current || generation !== scope.current.generation) return;
          if (statuses.some((status, index) => !exclusionConfirmed(batch[index], status))) setFailure({ generation, kind: 'loadFailed' });
          setEntries(previous => {
            if (generation !== scope.current.generation) return previous;
            const next = new Map(previous);
            statuses.forEach((status, index) => {
              const target = batch[index], key = exclusionKey(target);
              // Reads that began before a mutation cannot replace its confirmed outcome.
              if (pending.current.has(key) || versions.current.get(key) !== atStart.get(key)) return;
              const known = exclusionConfirmed(target, status);
              const old = next.get(key);
              next.set(key, { signature: target.signature, generation, known,
                excluded: known ? status.excluded : status.excluded || old?.excluded === true });
            });
            return next;
          });
        } catch {
          if (controller.signal.aborted || !mounted.current || generation !== scope.current.generation) return;
          setFailure({ generation, kind: 'loadFailed' });
          exclusionLog('status.failed', 'warn', { count: batch.length, generation });
        }
      }
      window.clearTimeout(timeout);
      controllers.current.delete(controller);
    })();
    return () => { window.clearTimeout(timeout); controller.abort(); controllers.current.delete(controller); };
  }, [scopeKey, source, generation]);
  function stateFor(asset: RecentAsset) {
    const target = exclusionTarget(asset);
    if (!target || !targets.has(exclusionKey(target))) {
      const key = exclusionKey({ kind: asset.stackId ? 'stack' : 'asset', id: asset.stackId ?? asset.id });
      return { target: null, excluded: entries.get(key)?.excluded === true, known: false };
    }
    const entry = entries.get(exclusionKey(target));
    const same = entry?.signature === target.signature;
    return { target, excluded: entry?.excluded === true, known: same && entry.generation === generation && entry.known && !pending.current.has(exclusionKey(target)) };
  }
  async function setExcluded(target: ExclusionTarget, excluded: boolean) {
    const key = exclusionKey(target), started = generation;
    pending.current.add(key);
    versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      await saveExclusion(target, excluded, controller.signal);
      if (!mounted.current || started !== scope.current.generation) return;
      setEntries(previous => started === scope.current.generation
        ? new Map(previous).set(key, { signature: target.signature, excluded, generation: started, known: true }) : previous);
      exclusionLog('mutation.completed', 'info', { targetId: target.id, excluded });
    } catch (cause) {
      if (mounted.current && started === scope.current.generation) {
        setEntries(previous => {
          const next = new Map(previous), old = next.get(key);
          if (old) next.set(key, { ...old, known: false });
          return next;
        });
        setFailure({ generation: started, kind: 'saveFailed' });
        exclusionLog('mutation.failed', 'error', { targetId: target.id, excluded });
      }
      throw cause;
    } finally {
      window.clearTimeout(timeout);
      pending.current.delete(key);
      // A view loaded during the write may have observed its pre-commit state.
      if (mounted.current && started !== scope.current.generation) setRefreshRevision(value => value + 1);
      versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
      controllers.current.delete(controller);
    }
  }
  return { stateFor, setExcluded, generation, failure: failure?.generation === generation ? failure.kind : null };
}
