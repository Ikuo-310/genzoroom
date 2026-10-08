import { lazy, Suspense } from 'react';
import { SettingsProvider } from './SettingsDialog';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AnshitsuPage } from './AnshitsuPage';
import { GalleryPage } from './GalleryPage';

const DeveloperPage = lazy(() => import('./DeveloperPage').then(module => ({ default: module.DeveloperPage })));

export function App() {
  return (
    <SettingsProvider><Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/stack" element={<Navigate to="/" replace />} />
      <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
      <Route path="/developer" element={<Suspense fallback={<p role="status">Loading…</p>}><DeveloperPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></SettingsProvider>
  );
}
