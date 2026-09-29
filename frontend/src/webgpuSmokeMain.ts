import { mountSmokePage, type SmokeEnvironment } from './webgpuSmoke';

const root = document.getElementById('smoke')!;
const environment: SmokeEnvironment = {
  secureContext: window.isSecureContext,
  gpu: (navigator as Navigator & { gpu?: SmokeEnvironment['gpu'] }).gpu,
};
let cleanup = mountSmokePage(root, environment);
window.addEventListener('pagehide', () => cleanup());
// A page restored from the back/forward cache needs a fresh owner and click handler.
window.addEventListener('pageshow', event => {
  if (event.persisted) cleanup = mountSmokePage(root, environment);
});
