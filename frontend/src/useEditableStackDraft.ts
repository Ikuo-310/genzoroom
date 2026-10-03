import { useEffect, useReducer } from 'react';
import type { RecentAsset } from './assets';
import { chooseStackCover, type DraftStack, type StackDetection } from './stackCandidateDetection';

export type EditableStackDraft = StackDetection & {
  sourceGroups: DraftStack[] | null;
  selectedIds: Set<string>;
  addTargetStackId: string | null;
  modified: boolean;
  manualCounter: number;
  order: ReadonlyMap<string, number>;
};
export const emptyStackDraft: EditableStackDraft = {
  groups: [], unmatched: [], sourceGroups: null, selectedIds: new Set(), addTargetStackId: null,
  modified: false, manualCounter: 0, order: new Map(),
};
export type StackDraftAction =
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
  | { type: 'cover'; groupId: string; assetId: string };

function normalize(state: EditableStackDraft): EditableStackDraft {
  const unmatched = [...state.unmatched].sort((a, b) => (state.order.get(a.id) ?? Infinity) - (state.order.get(b.id) ?? Infinity));
  const ids = new Set(unmatched.map(asset => asset.id));
  return { ...state, unmatched, selectedIds: new Set([...state.selectedIds].filter(id => ids.has(id))),
    addTargetStackId: state.groups.some(group => group.id === state.addTargetStackId) ? state.addTargetStackId : null };
}

export function stackDraftReducer(state: EditableStackDraft, action: StackDraftAction): EditableStackDraft {
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
    if (!state.groups.some(group => group.id === action.groupId)) return state;
    return { ...state, addTargetStackId: state.addTargetStackId === action.groupId ? null : action.groupId };
  }
  if (action.type === 'add' || action.type === 'create') {
    const members = state.unmatched.filter(asset => state.selectedIds.has(asset.id));
    const targetGroupId = action.type === 'add' ? action.targetGroupId ?? state.addTargetStackId : null;
    if (action.type === 'create' ? members.length < 2 : !members.length || !state.groups.some(group => group.id === targetGroupId)) return state;
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
  if (!group.members.some(member => member.id === action.assetId)) return state;
  if (action.type === 'cover') {
    if (group.coverAssetId === action.assetId) return state;
    return { ...state, modified: true, groups: state.groups.map(current => current === group
      ? { ...group, coverAssetId: action.assetId, ...(group.origin === 'immich' ? { modified: true } : {}) } : current) };
  }
  const members = group.members.filter(member => member.id !== action.assetId);
  const dissolved = members.length < 2;
  const updated = { ...group, members, modified: true, coverAssetId: group.coverAssetId === action.assetId ? chooseStackCover(members) : group.coverAssetId };
  return normalize({ ...state, modified: true,
    groups: dissolved ? state.groups.filter(current => current !== group) : state.groups.map(current => current === group ? updated : current),
    unmatched: [...state.unmatched, ...(dissolved ? group.members : group.members.filter(member => member.id === action.assetId))] });
}

export function useEditableStackDraft(source: StackDetection, loading: boolean, assets: readonly RecentAsset[]) {
  const [draft, dispatch] = useReducer(stackDraftReducer, emptyStackDraft);
  useEffect(() => {
    // Source identities change only for detection runs. Never synchronize on manual edits.
    if (!loading && draft.sourceGroups !== source.groups) dispatch({ type: 'initialize', source, assets });
  }, [source.groups, source.unmatched, loading, draft.sourceGroups, assets]);
  return { draft, dispatch, ready: !loading && draft.sourceGroups === source.groups };
}
