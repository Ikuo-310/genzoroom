export type BuildChannel = 'development' | 'validation' | 'stable';
export interface BuildInfo { name: 'GenzoRoom'; version: string; channel: BuildChannel; commit: string | null }

const channel = import.meta.env.VITE_GENZOROOM_CHANNEL || 'development';
const version = import.meta.env.VITE_GENZOROOM_VERSION || '0.0.0-development';
const commit = import.meta.env.VITE_GENZOROOM_COMMIT || null;
const fullCommit = commit === null || /^[0-9a-f]{40}$/.test(commit);
const stableVersion = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version);
if (channel === 'development' ? version !== '0.0.0-development' || commit !== null
  : channel === 'validation' ? version !== '0.0.0-validation' || !commit || !fullCommit
    : channel === 'stable' ? !stableVersion || !commit || !fullCommit : true) {
  throw new Error('Invalid GenzoRoom build metadata');
}

export const BUILD_INFO: BuildInfo = { name: 'GenzoRoom', version, channel: channel as BuildChannel, commit };
