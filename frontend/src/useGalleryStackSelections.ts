import { useSyncExternalStore } from 'react';
import type { RecentAsset } from './assets';
import type { AnshitsuInitialSelection } from './appSettings';
import { selectGalleryAssetTargets, type GalleryAssetSelection } from './galleryAssetSelection';

export const GALLERY_STACK_SELECTION_SESSION_KEY = 'genzoroom.galleryStackSelections.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SelectionMap = Map<string, Set<string>>;
type CurrentStackSnapshot = { requestGeneration: number; card: RecentAsset | null };

function sessionStorageOrUndefined(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

function readSelections(): SelectionMap {
  try {
    const raw = sessionStorageOrUndefined()?.getItem(GALLERY_STACK_SELECTION_SESSION_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1
      || !(parsed as { selections?: unknown }).selections || typeof (parsed as { selections: unknown }).selections !== 'object'
      || Array.isArray((parsed as { selections: unknown }).selections)) return new Map();
    const result = new Map<string, Set<string>>();
    for (const [stackId, ids] of Object.entries((parsed as { selections: Record<string, unknown> }).selections)) {
      if (!UUID.test(stackId) || !Array.isArray(ids) || !ids.every(id => typeof id === 'string' && UUID.test(id))) return new Map();
      const normalized = ids.map(id => id.toLowerCase());
      if (new Set(normalized).size !== normalized.length) return new Map();
      result.set(stackId.toLowerCase(), new Set(normalized));
    }
    return result;
  } catch { return new Map(); }
}

let manualSelections = readSelections();
let revision = 0;
let latestRequestGeneration = 0;
const pendingSnapshotRequests = new Set<number>();
const currentStackSnapshots = new Map<string, CurrentStackSnapshot>();
const listeners = new Set<() => void>();

export function clearGalleryStackSnapshots(): void {
  if (currentStackSnapshots.size === 0 && pendingSnapshotRequests.size === 0) return;
  currentStackSnapshots.clear();
  pendingSnapshotRequests.clear();
  publish();
}

export function restoreGalleryStackSelectionsFromSession(): void {
  manualSelections = readSelections();
  clearGalleryStackSnapshots();
  latestRequestGeneration = 0;
  publish();
}

export function beginGalleryStackSnapshotRequest(): number {
  const generation = ++latestRequestGeneration;
  pendingSnapshotRequests.add(generation);
  return generation;
}

export function finishGalleryStackSnapshotRequest(requestGeneration: number): void {
  // Failure and cancellation release the reconciliation barrier without replacing accepted evidence.
  if (pendingSnapshotRequests.delete(requestGeneration)) publish();
}

export function acceptGalleryStackSnapshots(assets: readonly RecentAsset[], requestGeneration: number): void {
  if (!pendingSnapshotRequests.has(requestGeneration)) return;
  const grouped = new Map<string, RecentAsset | null>();
  const returnedStackByAssetId = new Map<string, string | null>();
  for (const asset of assets) {
    returnedStackByAssetId.set(asset.id.toLowerCase(), asset.stackId?.toLowerCase() ?? null);
    if (asset.stackId == null) continue;
    const key = asset.stackId.toLowerCase();
    if (grouped.has(key)) {
      grouped.set(key, null);
      continue;
    }
    grouped.set(key, selectGalleryAssetTargets(asset, 'both').status === 'ready' ? asset : null);
  }
  for (const [stackId, snapshot] of currentStackSnapshots) {
    const primaryId = snapshot.card?.id.toLowerCase();
    if (primaryId && returnedStackByAssetId.has(primaryId) && returnedStackByAssetId.get(primaryId) !== stackId) {
      grouped.set(stackId, null);
    }
  }
  let changed = false;
  for (const [stackId, card] of grouped) {
    const existing = currentStackSnapshots.get(stackId);
    if (existing && existing.requestGeneration > requestGeneration) continue;
    currentStackSnapshots.set(stackId, { requestGeneration, card });
    changed = true;
  }
  const finished = pendingSnapshotRequests.delete(requestGeneration);
  if (changed || finished) publish();
}

function currentCardFor(card: RecentAsset): RecentAsset {
  if (card.stackId == null) return card;
  const current = currentStackSnapshots.get(card.stackId.toLowerCase());
  if (!current) return card;
  // A newer tab response is the shared candidate source even while another tab keeps older display data.
  return current.card ?? { ...card, stackMembers: null };
}

function canReconcile(card: RecentAsset): boolean {
  if (card.stackId == null) return false;
  const current = currentStackSnapshots.get(card.stackId.toLowerCase());
  if (current) return ![...pendingSnapshotRequests].some(generation => generation > current.requestGeneration);
  // Pure callers without Gallery fetches retain the existing complete-snapshot behavior.
  return latestRequestGeneration === 0;
}

function publish() { revision++; listeners.forEach(listener => listener()); }
function persist() {
  const selections = Object.fromEntries([...manualSelections].map(([stackId, ids]) => [stackId, [...ids]]));
  try { sessionStorageOrUndefined()?.setItem(GALLERY_STACK_SELECTION_SESSION_KEY, JSON.stringify({ version: 1, selections })); }
  catch { /* Keep the in-memory selection for this page session when storage is blocked. */ }
}

export function getManualGalleryStackSelection(stackId: string): ReadonlySet<string> | undefined {
  return manualSelections.get(stackId.toLowerCase());
}

export function resolveGalleryStackSelection(card: RecentAsset, preset: AnshitsuInitialSelection): GalleryAssetSelection {
  if (card.stackId == null) return selectGalleryAssetTargets(card, preset);
  const current = currentCardFor(card);
  const stackId = card.stackId.toLowerCase();
  const manual = manualSelections.get(stackId);
  const result = selectGalleryAssetTargets(current, preset, manual);
  // Only shared accepted evidence may prune intent, after any newer unresolved requests have settled.
  if (result.status === 'ready' && manual !== undefined && canReconcile(current)) {
    const reconciled = new Set(result.selectedAssetIds);
    if (manual.size !== reconciled.size || [...manual].some(id => !reconciled.has(id))) {
      manualSelections = new Map(manualSelections).set(stackId, reconciled);
      persist(); publish();
    }
  }
  return result;
}

export function setManualGalleryStackSelection(card: RecentAsset, selectedAssetIds: ReadonlySet<string>): boolean {
  if (card.stackId == null || [...selectedAssetIds].some(id => !UUID.test(id))) return false;
  const current = currentCardFor(card);
  const result = selectGalleryAssetTargets(current, 'nonRaw', selectedAssetIds);
  if (result.status !== 'ready') return false;
  manualSelections = new Map(manualSelections).set(card.stackId.toLowerCase(), new Set(result.selectedAssetIds));
  persist(); publish();
  return true;
}

export function clearManualGalleryStackSelection(stackId: string): void {
  const key = stackId.toLowerCase();
  if (!manualSelections.has(key)) return;
  manualSelections = new Map(manualSelections);
  manualSelections.delete(key);
  persist(); publish();
}

export function useGalleryStackSelections() {
  const selectionRevision = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => revision, () => revision);
  return { revision: selectionRevision, resolve: resolveGalleryStackSelection, setManualSelection: setManualGalleryStackSelection,
    clearManualSelection: clearManualGalleryStackSelection, getManualSelection: getManualGalleryStackSelection,
    currentCard: currentCardFor };
}
