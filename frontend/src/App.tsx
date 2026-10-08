import { lazy, Suspense } from 'react';
import { SettingsProvider } from './SettingsDialog';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnshitsuPage } from './AnshitsuPage';
import { GalleryPage } from './GalleryPage';

const DeveloperPage = lazy(() => import('./DeveloperPage').then(module => ({ default: module.DeveloperPage })));

export function App() {
  const location = useLocation();
  const isHome = location.pathname === '/';
  // Keep Home's in-memory Stack draft mounted while Anshitsu is a routed workspace.
  const keepHomeSession = isHome || location.pathname.startsWith('/anshitsu/');
  return (
    <SettingsProvider>
      {keepHomeSession && <div hidden={!isHome}><GalleryPage active={isHome} /></div>}
      <Routes>
        <Route path="/" element={null} />
        <Route path="/stack" element={<Navigate to="/" replace />} />
        <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
        <Route path="/developer" element={<Suspense fallback={<p role="status">Loading…</p>}><DeveloperPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SettingsProvider>
  );
}
