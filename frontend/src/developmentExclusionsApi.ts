import type { RecentAsset } from './assets';
import { frontendLogger, type LogEntryLevel, type LogContextValue } from './frontendLogging';

export type ExclusionTarget = { kind: 'asset' | 'stack'; id: string; memberIds: string[]; signature: string };
export type ExclusionStatus = { kind: 'asset' | 'stack'; id: string; excluded: boolean; configuration: 'confirmed' | 'absent' | 'single' | 'stacked' | 'unknown' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const exclusionDiagnosticId = (value: string) => UUID.test(value) ? value.toLowerCase() : null;
export const exclusionKey = (target: Pick<ExclusionTarget, 'kind' | 'id'>) => `${target.kind}:${target.id.toLowerCase()}`;

export function exclusionTarget(asset: RecentAsset): ExclusionTarget | null {
  if (!UUID.test(asset.id)) return null;
  const assetId = asset.id.toLowerCase();
  if (asset.stackId == null) {
    if (asset.primaryAssetId != null || asset.stackMemberIds != null || asset.stackAssetCount != null) return null;
    return { kind: 'asset', id: assetId, memberIds: [assetId], signature: assetId };
  }
  const id = asset.stackId.toLowerCase(), primary = asset.primaryAssetId?.toLowerCase();
  const members = asset.stackMemberIds?.map(value => value.toLowerCase()).sort();
  if (!UUID.test(id) || !primary || !UUID.test(primary) || !members?.length
    || members.some(value => !UUID.test(value)) || new Set(members).size !== members.length
    || !members.includes(primary) || !members.includes(assetId) || asset.stackAssetCount !== members.length) return null;
  if (asset.stackMembers && (asset.stackMembers.length !== members.length
    || new Set(asset.stackMembers.map(member => member.id.toLowerCase())).size !== members.length
    || asset.stackMembers.some(member => !members.includes(member.id.toLowerCase())
      || member.stackId?.toLowerCase() !== id || member.primaryAssetId?.toLowerCase() !== primary))) return null;
  return { kind: 'stack', id, memberIds: members, signature: JSON.stringify([primary, members]) };
}

export function exclusionLog(event: string, level: LogEntryLevel, context: Record<string, LogContextValue> = {}) {
  try { frontendLogger.add({ component: 'developmentExclusions', event, level, context }); }
  catch { /* Diagnostics cannot change Gallery operations. */ }
}

function checkedStatus(value: unknown, target: ExclusionTarget): ExclusionStatus {
  const item = value as Partial<ExclusionStatus> | null;
  if (!item || item.kind !== target.kind || typeof item.id !== 'string' || item.id.toLowerCase() !== target.id
    || typeof item.excluded !== 'boolean' || !['confirmed', 'absent', 'single', 'stacked', 'unknown'].includes(item.configuration ?? '')) {
    throw new Error('invalid_exclusion_response');
  }
  return { kind: target.kind, id: target.id, excluded: item.excluded, configuration: item.configuration! };
}
export function exclusionConfirmed(target: ExclusionTarget, status: ExclusionStatus) {
  return status.configuration === (target.kind === 'stack' ? 'confirmed' : 'single');
}
async function request(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(path, { ...init, cache: 'no-store' });
  if (!response.ok) throw new Error('exclusion_request_failed');
  return response;
}
export async function getExclusionStatuses(targets: ExclusionTarget[], signal: AbortSignal): Promise<ExclusionStatus[]> {
  if (targets.length > 100) throw new Error('exclusion_batch_limit');
  const response = await request('/api/development-exclusions/status', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: targets.map(({ kind, id }) => ({ kind, id })) }),
  });
  const body: unknown = await response.json();
  const items = (body as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items) || items.length !== targets.length) throw new Error('invalid_exclusion_response');
  const statuses = targets.map(target => {
    const matches = items.filter(item => item && typeof item === 'object' && (item as ExclusionStatus).kind === target.kind
      && typeof (item as ExclusionStatus).id === 'string' && (item as ExclusionStatus).id.toLowerCase() === target.id);
    if (matches.length !== 1) throw new Error('invalid_exclusion_response');
    return checkedStatus(matches[0], target);
  });
  return statuses;
}
export async function saveExclusion(target: ExclusionTarget, excluded: boolean, signal: AbortSignal): Promise<void> {
  const response = await request(`/api/development-exclusions/${target.kind}/${target.id}`, { method: excluded ? 'PUT' : 'DELETE', signal });
  if (!excluded) {
    if (response.status !== 204) throw new Error('invalid_exclusion_response');
  } else {
    const status = checkedStatus(await response.json(), target);
    if (!status.excluded || !exclusionConfirmed(target, status)) throw new Error('invalid_exclusion_response');
  }
}
