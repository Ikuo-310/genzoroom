import { useEffect, useRef, useState } from 'react';
import type { RecentAsset } from './assets';
import { exclusionConfirmed, exclusionDiagnosticId, exclusionKey, exclusionLog, exclusionTarget, getExclusionStatuses, saveExclusion, type ExclusionTarget, type ExclusionStatus } from './developmentExclusionsApi';

type Entry = { signature: string; excluded: boolean; generation: number; known: boolean;
  configuration?: ExclusionStatus['configuration']; mutationUncertain?: boolean };
type LoadPhase = 'queued' | 'loading' | 'completed' | 'failed' | 'timeout';
type LoadEvidence = { generation: number; requestId: number; phase: LoadPhase; startVersion: number };
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
  const scope = useRef({ key: scopeKey, source, generation: 0, changeReason: 'initial' });
  if (scope.current.key !== scopeKey || scope.current.source !== source) {
    scope.current = { key: scopeKey, source, generation: scope.current.generation + 1,
      changeReason: scope.current.source !== source ? 'source_changed' : 'scope_changed' };
  }
  const generation = scope.current.generation;
  const [entries, setEntries] = useState(new Map<string, Entry>());
  const [failure, setFailure] = useState<{ generation: number; kind: 'loadFailed' | 'saveFailed' } | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const versions = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const nextRequestId = useRef(0);
  const loadEvidence = useRef(new Map<string, LoadEvidence>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controllers.current.forEach(c => c.abort()); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const requested = [...targets.values()];
    const atStart = new Map(versions.current);
    const requestId = ++nextRequestId.current;
    loadEvidence.current = new Map(requested.map(target => [exclusionKey(target), {
      generation, requestId, phase: 'queued', startVersion: atStart.get(exclusionKey(target)) ?? 0,
    }]));
    if (requested.length) exclusionLog('status.started', 'debug', {
      requestId, generation, count: requested.length, changeReason: scope.current.changeReason,
    });
    setFailure(null);
    const timeout = window.setTimeout(() => {
      if (mounted.current && generation === scope.current.generation) {
        for (const evidence of loadEvidence.current.values()) if (evidence.phase === 'queued' || evidence.phase === 'loading') evidence.phase = 'timeout';
        setFailure({ generation, kind: 'loadFailed' });
        exclusionLog('status.failed', 'warn', { requestId, generation, errorCode: 'timeout' });
      }
      controller.abort();
    }, 15000);
    void (async () => {
      for (let offset = 0; offset < requested.length; offset += 100) {
        const batch = requested.slice(offset, offset + 100);
        for (const target of batch) {
          const evidence = loadEvidence.current.get(exclusionKey(target));
          if (evidence?.generation === generation && evidence.requestId === requestId) evidence.phase = 'loading';
        }
        try {
          const statuses = await getExclusionStatuses(batch, controller.signal);
          if (controller.signal.aborted || !mounted.current || generation !== scope.current.generation) {
            exclusionLog('status.discarded', 'debug', { requestId, generation, currentGeneration: scope.current.generation,
              errorCode: controller.signal.aborted ? 'aborted' : 'stale' });
            return;
          }
          for (const target of batch) {
            const evidence = loadEvidence.current.get(exclusionKey(target));
            if (evidence?.generation === generation && evidence.requestId === requestId) evidence.phase = 'completed';
          }
          exclusionLog('status.received', 'debug', { requestId, generation, count: statuses.length,
            confirmedCount: statuses.filter((status, index) => exclusionConfirmed(batch[index], status)).length,
            unknownCount: statuses.filter(status => status.configuration === 'unknown').length });
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
              next.set(key, { signature: target.signature, generation, known, configuration: status.configuration,
                excluded: known ? status.excluded : status.excluded || old?.excluded === true });
            });
            return next;
          });
        } catch {
          if (controller.signal.aborted || !mounted.current || generation !== scope.current.generation) return;
          for (const target of batch) {
            const evidence = loadEvidence.current.get(exclusionKey(target));
            if (evidence?.generation === generation && evidence.requestId === requestId) evidence.phase = 'failed';
          }
          setFailure({ generation, kind: 'loadFailed' });
          exclusionLog('status.failed', 'warn', { count: batch.length, requestId, generation, errorCode: 'request_failed' });
        }
      }
      window.clearTimeout(timeout);
      controllers.current.delete(controller);
    })();
    return () => { window.clearTimeout(timeout); controller.abort(); controllers.current.delete(controller); };
  }, [scopeKey, source, generation]);
  function stateFor(asset: RecentAsset) {
    const target = exclusionTarget(asset);
    const key = exclusionKey({ kind: asset.stackId ? 'stack' : 'asset', id: asset.stackId ?? asset.id });
    const entry = entries.get(key);
    const same = entry?.signature === target?.signature;
    const pendingMutation = pending.current.has(key);
    const evidence = loadEvidence.current.get(key);
    const phase = evidence?.generation === generation ? evidence.phase : 'not_requested';
    let reason = 'ready';
    if (!target) reason = 'target_unresolved';
    else if (conflicts.has(key)) reason = 'ownership_conflict';
    else if (!visibleKeys.has(key)) reason = 'not_visible';
    else if (!targets.has(key)) reason = 'snapshot_target_missing';
    else if (pendingMutation) reason = 'mutation_pending';
    else if (!entry) reason = phase === 'loading' ? 'loading' : phase === 'queued' ? 'not_loaded'
      : phase === 'failed' ? 'load_failed' : phase === 'timeout' ? 'load_timeout' : 'entry_missing';
    else if (!same) reason = 'signature_mismatch';
    else if (entry.generation !== generation) reason = 'generation_mismatch';
    else if (!entry.known) reason = entry.mutationUncertain ? 'mutation_uncertain'
      : entry.configuration === 'unknown' ? 'configuration_unknown' : 'configuration_mismatch';
    // Diagnostic evidence is observational; authorization retains the existing signature/generation guards.
    const available = target !== null && targets.has(key);
    return { target: available ? target : null, excluded: entry?.excluded === true,
      known: available && same && entry!.generation === generation && entry!.known && !pendingMutation,
      diagnostic: { assetId: exclusionDiagnosticId(asset.id), targetId: target?.id ?? exclusionDiagnosticId(asset.stackId ?? asset.id),
        kind: asset.stackId ? 'stack' : 'asset', cachedExcluded: entry?.excluded === true, reason, generation, entryGeneration: entry?.generation ?? null,
        configuration: entry?.configuration ?? null, loadPhase: phase, requestId: evidence?.requestId ?? null,
        signatureMatches: entry ? same : null, pending: pendingMutation,
        version: versions.current.get(key) ?? 0, requestStartVersion: evidence?.startVersion ?? null } };
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
        ? new Map(previous).set(key, { signature: target.signature, excluded, generation: started, known: true,
          configuration: target.kind === 'stack' ? 'confirmed' : 'single' }) : previous);
      exclusionLog('mutation.completed', 'info', { targetId: target.id, kind: target.kind, excluded, generation: started });
    } catch (cause) {
      if (mounted.current && started === scope.current.generation) {
        setEntries(previous => {
          const next = new Map(previous), old = next.get(key);
          if (old) next.set(key, { ...old, known: false, mutationUncertain: true });
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
