import { SettingsProvider } from './SettingsDialog';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AnshitsuPage } from './AnshitsuPage';
import { GalleryPage } from './GalleryPage';

export function App() {
  return (
    <SettingsProvider><Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></SettingsProvider>
  );
}
