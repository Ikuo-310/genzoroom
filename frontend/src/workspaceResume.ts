import type { WorkspaceNavigationState } from './assets';

let workspaceSession: WorkspaceNavigationState | null = null;

export function rememberWorkspaceSession(state: WorkspaceNavigationState) {
  if (state.selectedAssets.length === 0 || !state.selectedAssets.some(asset => asset.id === state.activeAssetId)) return;
  workspaceSession = { ...state, selectedAssets: [...state.selectedAssets] };
}

export function readWorkspaceSession(): WorkspaceNavigationState | null {
  return workspaceSession ? { ...workspaceSession, selectedAssets: [...workspaceSession.selectedAssets] } : null;
}

export function clearWorkspaceSession() {
  workspaceSession = null;
}
