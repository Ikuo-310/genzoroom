import { useEffect, useReducer } from 'react';
import type { RecentAsset } from './assets';
import { isSingletonImmichStack, isStackDraftModified, reconcileImmichLineage } from './immichStackDraft';
import { chooseStackCover, type DraftStack, type StackDetection } from './stackCandidateDetection';
import type { StackWritePlan, StackWriteResult } from './stackWrite';

export type EditableStackDraft = StackDetection & {
  sourceGroups: DraftStack[] | null;
  completedSourceIds: Set<string>;
  writeResults: Record<string, StackWriteResult>;
  selectedIds: Set<string>;
  addTargetStackId: string | null;
  modified: boolean;
  manualCounter: number;
  order: ReadonlyMap<string, number>;
  undoSnapshot: StackDraftSnapshot | null;
};
type StackDraftSnapshot = Pick<EditableStackDraft, 'groups' | 'unmatched' | 'manualCounter'>;
export const emptyStackDraft: EditableStackDraft = {
  groups: [], unmatched: [], sourceGroups: null, completedSourceIds: new Set(), writeResults: {}, selectedIds: new Set(), addTargetStackId: null,
  modified: false, manualCounter: 0, order: new Map(), undoSnapshot: null,
};
export type StackDraftAction =
  | { type: 'writeResults'; plan: StackWritePlan; results: StackWriteResult[] }
  | { type: 'initialize'; source: StackDetection; assets: readonly RecentAsset[] }
  | { type: 'reset' }
  | { type: 'clear' }
  | { type: 'clearSelection' }
  | { type: 'add'; targetGroupId?: string }
  | { type: 'create' }
  | { type: 'select'; assetId: string }
  | { type: 'target'; groupId: string }
  | { type: 'purgeGroup'; groupId: string }
  | { type: 'purgeMember'; groupId: string; assetId: string }
  | { type: 'cover'; groupId: string; assetId: string }
  | { type: 'dropUnmatched'; assetId: string; targetGroupId: string }
  | { type: 'createFromUnmatchedDrop'; draggedAssetId: string; targetAssetId: string }
  | { type: 'moveMember'; assetId: string; sourceGroupId: string; targetGroupId: string }
  | { type: 'undo' }
  | { type: 'clearUndo' };
type StackDraftEditAction = Exclude<StackDraftAction, { type: 'undo' | 'clearUndo' }>;

function normalize(state: EditableStackDraft): EditableStackDraft {
  const source = (state.sourceGroups ?? []).filter(group => !state.completedSourceIds.has(group.id));
  const groups = reconcileImmichLineage(state.groups, source);
  const unmatched = [...state.unmatched].sort((a, b) => (state.order.get(a.id) ?? Infinity) - (state.order.get(b.id) ?? Infinity));
  const ids = new Set(unmatched.map(asset => asset.id));
  return { ...state, groups, modified: isStackDraftModified(groups, source), unmatched, selectedIds: new Set([...state.selectedIds].filter(id => ids.has(id))),
    addTargetStackId: groups.some(group => group.id === state.addTargetStackId && !isSingletonImmichStack(group)) ? state.addTargetStackId : null };
}

function reduceStackDraft(state: EditableStackDraft, action: StackDraftEditAction): EditableStackDraft {
  if (action.type === 'writeResults') {
    const completedSourceIds = new Set(state.completedSourceIds);
    const removed = new Set(action.plan.unchanged);
    const writeResults = { ...state.writeResults };
    for (const result of action.results) {
      const op = action.plan.operations.find(operation => operation.operationId === result.operationId)!;
      const groupId = op.type === 'delete' ? null : action.plan.operationGroupIds?.[result.operationId] ?? op.operationId;
      writeResults[groupId ?? `delete:${op.stackId}`] = result;
      if (result.status === 'success' && groupId !== null) removed.add(groupId);
      for (const source of state.sourceGroups ?? []) {
        if ((source.origin === 'immich' && (source.immichStackId === result.releasedStackId
          || (result.status === 'success' && source.immichStackId === op.stackId))) || removed.has(source.id)) completedSourceIds.add(source.id);
      }
    }
    for (const id of removed) {
      completedSourceIds.add(id);
      const current = state.groups.find(group => group.id === id);
      if (current?.origin === 'immich') {
        for (const original of state.sourceGroups ?? []) {
          if (original.origin === 'immich' && original.immichStackId === current.immichStackId) completedSourceIds.add(original.id);
        }
      }
    }
    const groups = state.groups.filter(group => !removed.has(group.id)).map(group => {
      const result = writeResults[group.id];
      if (group.origin !== 'immich' || result?.releasedStackId !== group.immichStackId) return group;
      // A replacement can fail after its delete committed; retry must create, never delete again.
      const { immichStackId: _stack, originalMemberIds: _members, originalPrimaryAssetId: _primary, ...local } = group;
      return { ...local, origin: 'manual' as const, modified: true };
    });
    return normalize({ ...state, groups, completedSourceIds, writeResults, selectedIds: new Set(), addTargetStackId: null, undoSnapshot: null });
  }
  if (action.type === 'initialize') return {
    ...emptyStackDraft, manualCounter: state.manualCounter, sourceGroups: action.source.groups,
    order: new Map(action.assets.map((asset, index) => [asset.id, index])),
    // Editable members and evidence never mutate the re-detectable source result.
    groups: action.source.groups.map(group => ({ ...group, members: [...group.members], evidence: { ...group.evidence } })),
    unmatched: [...action.source.unmatched], selectedIds: new Set(),
  };
  if (action.type === 'reset') return { ...emptyStackDraft, manualCounter: state.manualCounter };
  if (action.type === 'clear' || action.type === 'clearSelection') return { ...state, selectedIds: new Set(),
    addTargetStackId: action.type === 'clear' ? null : state.addTargetStackId };
  if (action.type === 'select') {
    if (!state.unmatched.some(asset => asset.id === action.assetId)) return state;
    const selectedIds = new Set(state.selectedIds);
    if (selectedIds.has(action.assetId)) selectedIds.delete(action.assetId); else selectedIds.add(action.assetId);
    return { ...state, selectedIds };
  }
  if (action.type === 'target') {
    if (!state.groups.some(group => group.id === action.groupId && !isSingletonImmichStack(group))) return state;
    return { ...state, addTargetStackId: state.addTargetStackId === action.groupId ? null : action.groupId };
  }
  if (action.type === 'dropUnmatched') {
    const asset = state.unmatched.find(current => current.id === action.assetId);
    const target = state.groups.find(current => current.id === action.targetGroupId);
    if (!asset || !target || isSingletonImmichStack(target) || state.groups.some(group => group.members.some(member => member.id === asset.id))
      || target.members.some(member => member.id === asset.id)) return state;
    return normalize({ ...state, modified: true, unmatched: state.unmatched.filter(current => current.id !== asset.id),
      selectedIds: new Set([...state.selectedIds].filter(id => id !== asset.id)), addTargetStackId: null,
      groups: state.groups.map(group => group === target ? { ...group, modified: true, members: [...group.members, asset] } : group) });
  }
  if (action.type === 'createFromUnmatchedDrop') {
    const { draggedAssetId, targetAssetId } = action;
    if (!draggedAssetId || draggedAssetId.length > 500 || !targetAssetId || targetAssetId.length > 500 || draggedAssetId === targetAssetId) return state;
    const ids = new Set([draggedAssetId, targetAssetId]);
    if (ids.size !== 2 || state.unmatched.filter(asset => asset.id === draggedAssetId).length !== 1
      || state.unmatched.filter(asset => asset.id === targetAssetId).length !== 1
      || state.unmatched.some(asset => ids.has(asset.id) && (!asset.id || asset.id.length > 500))
      || state.groups.some(group => group.members.some(member => ids.has(member.id)))) return state;
    const members = state.unmatched.filter(asset => ids.has(asset.id));
    const group: DraftStack = { id: `draft:manual:${state.manualCounter + 1}`, origin: 'manual', members,
      coverAssetId: chooseStackCover(members), evidence: { name: 'unavailable', nameReason: 'exact', time: 'unavailable', camera: 'unavailable', gps: 'unavailable' } };
    return normalize({ ...state, modified: true, groups: [...state.groups, group], unmatched: state.unmatched.filter(asset => !ids.has(asset.id)),
      selectedIds: new Set([...state.selectedIds].filter(id => !ids.has(id))), addTargetStackId: null, manualCounter: state.manualCounter + 1 });
  }
  if (action.type === 'moveMember') {
    if (action.sourceGroupId === action.targetGroupId) return state;
    const source = state.groups.find(group => group.id === action.sourceGroupId);
    const target = state.groups.find(group => group.id === action.targetGroupId);
    const asset = source?.members.find(member => member.id === action.assetId);
    if (!source || !target || !asset || isSingletonImmichStack(source) || isSingletonImmichStack(target) || target.members.some(member => member.id === asset.id)
      || state.groups.some(group => group !== source && group.members.some(member => member.id === asset.id))
      || state.unmatched.some(member => member.id === asset.id)) return state;
    const remaining = source.members.filter(member => member.id !== asset.id);
    const dissolve = remaining.length < 2;
    const nextGroups = state.groups.filter(group => !dissolve || group !== source).map(group => {
      if (group === target) return { ...group, modified: true, members: [...group.members, asset] };
      if (group !== source) return group;
      return { ...group, members: remaining, modified: true,
        coverAssetId: source.coverAssetId === asset.id ? chooseStackCover(remaining) : source.coverAssetId };
    });
    return normalize({ ...state, modified: true, groups: nextGroups,
      unmatched: dissolve ? [...state.unmatched, ...remaining] : state.unmatched, addTargetStackId: null });
  }
  if (action.type === 'add' || action.type === 'create') {
    const members = state.unmatched.filter(asset => state.selectedIds.has(asset.id));
    const targetGroupId = action.type === 'add' ? action.targetGroupId ?? state.addTargetStackId : null;
    if (action.type === 'create' ? members.length < 2 : !members.length || !state.groups.some(group => group.id === targetGroupId && !isSingletonImmichStack(group))) return state;
    const ids = new Set(members.map(asset => asset.id));
    const group: DraftStack = { id: `draft:manual:${state.manualCounter + 1}`, origin: 'manual', members,
      coverAssetId: chooseStackCover(members), evidence: { name: 'unavailable', nameReason: 'exact', time: 'unavailable', camera: 'unavailable', gps: 'unavailable' } };
    return normalize({ ...state, modified: true, unmatched: state.unmatched.filter(asset => !ids.has(asset.id)), addTargetStackId: null,
      manualCounter: state.manualCounter + (action.type === 'create' ? 1 : 0),
      groups: action.type === 'create' ? [...state.groups, group] : state.groups.map(current => current.id === targetGroupId
        ? { ...current, modified: true, members: [...current.members, ...members.filter(asset => !current.members.some(member => member.id === asset.id))] } : current) });
  }
  const group = state.groups.find(current => current.id === action.groupId);
  if (!group) return state;
  if (action.type === 'purgeGroup') return normalize({ ...state, modified: true,
    groups: state.groups.filter(current => current !== group), unmatched: [...state.unmatched, ...group.members] });
  // Invalid singleton sources are dissolve-only, including actions dispatched outside the UI.
  if (isSingletonImmichStack(group)) return state;
  if (!group.members.some(member => member.id === action.assetId)) return state;
  if (action.type === 'cover') {
    if (group.coverAssetId === action.assetId) return state;
    return normalize({ ...state, modified: true, groups: state.groups.map(current => current === group
      ? { ...group, coverAssetId: action.assetId, ...(group.origin === 'immich' ? { modified: true } : {}) } : current) });
  }
  const members = group.members.filter(member => member.id !== action.assetId);
  const dissolved = members.length < 2;
  const updated = { ...group, members, modified: true, coverAssetId: group.coverAssetId === action.assetId ? chooseStackCover(members) : group.coverAssetId };
  return normalize({ ...state, modified: true,
    groups: dissolved ? state.groups.filter(current => current !== group) : state.groups.map(current => current === group ? updated : current),
    unmatched: [...state.unmatched, ...(dissolved ? group.members : group.members.filter(member => member.id === action.assetId))] });
}

const UNDOABLE_ACTIONS = new Set<StackDraftAction['type']>([
  'cover', 'add', 'create', 'createFromUnmatchedDrop', 'purgeMember', 'purgeGroup', 'dropUnmatched', 'moveMember',
]);

export function stackDraftReducer(state: EditableStackDraft, action: StackDraftAction): EditableStackDraft {
  if (action.type === 'clearUndo') return state.undoSnapshot ? { ...state, undoSnapshot: null } : state;
  if (action.type === 'undo') {
    if (!state.undoSnapshot) return state;
    // Only local draft structure is historical; source and write outcomes must stay current.
    return normalize({ ...state, ...state.undoSnapshot, undoSnapshot: null, selectedIds: new Set(), addTargetStackId: null });
  }
  const next = reduceStackDraft(state, action);
  if (action.type === 'initialize' || action.type === 'reset' || action.type === 'writeResults') return next;
  if (!UNDOABLE_ACTIONS.has(action.type) || next === state) return next;
  return { ...next, undoSnapshot: { groups: state.groups, unmatched: state.unmatched, manualCounter: state.manualCounter } };
}

export function useEditableStackDraft(source: StackDetection, loading: boolean, assets: readonly RecentAsset[]) {
  const [draft, dispatch] = useReducer(stackDraftReducer, emptyStackDraft);
  useEffect(() => {
    // Source identities change only for detection runs. Never synchronize on manual edits.
    if (!loading && draft.sourceGroups !== source.groups) dispatch({ type: 'initialize', source, assets });
  }, [source.groups, source.unmatched, loading, draft.sourceGroups, assets]);
  return { draft, dispatch, ready: !loading && draft.sourceGroups === source.groups };
}
