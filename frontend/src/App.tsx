import { Navigate, Route, Routes } from 'react-router-dom';
import { AnshitsuPage } from './AnshitsuPage';
import { GalleryPage } from './GalleryPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
