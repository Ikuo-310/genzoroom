import { useSyncExternalStore } from 'react';
import type { RecentAsset } from './assets';
import type { AnshitsuInitialSelection } from './appSettings';
import { selectGalleryAssetTargets, type GalleryAssetSelection } from './galleryAssetSelection';

export const GALLERY_STACK_SELECTION_SESSION_KEY = 'genzoroom.galleryStackSelections.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SelectionMap = Map<string, Set<string>>;

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
const listeners = new Set<() => void>();

export function restoreGalleryStackSelectionsFromSession(): void {
  manualSelections = readSelections();
  publish();
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
  const manual = manualSelections.get(card.stackId.toLowerCase());
  const result = selectGalleryAssetTargets(card, preset, manual);
  // Keep stored intent through temporary data failures; only a complete latest snapshot can reconcile it.
  if (result.status === 'ready' && manual !== undefined) {
    const reconciled = new Set(result.selectedAssetIds);
    if (manual.size !== reconciled.size || [...manual].some(id => !reconciled.has(id))) {
      manualSelections = new Map(manualSelections).set(card.stackId.toLowerCase(), reconciled);
      persist(); publish();
    }
  }
  return result;
}

export function setManualGalleryStackSelection(card: RecentAsset, selectedAssetIds: ReadonlySet<string>): boolean {
  if (card.stackId == null || [...selectedAssetIds].some(id => !UUID.test(id))) return false;
  const result = selectGalleryAssetTargets(card, 'nonRaw', selectedAssetIds);
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
  useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => revision, () => revision);
  return { resolve: resolveGalleryStackSelection, setManualSelection: setManualGalleryStackSelection,
    clearManualSelection: clearManualGalleryStackSelection, getManualSelection: getManualGalleryStackSelection };
}
