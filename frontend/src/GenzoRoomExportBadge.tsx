import { useTranslation } from 'react-i18next';

export function GenzoRoomExportBadge() {
  const { t } = useTranslation();
  const description = t('photos.genzoRoomExport');
  return <span className="genzoroom-export-badge" role="img" title={description} aria-label={description}>
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="currentColor">
      {/* Original broad strokes keep the 王 and 見 radicals legible at thumbnail size without a font dependency. */}
      <path d="M2 3.5 10 3l.2 2.8-8 .4ZM2.7 10l6.6-.4.2 2.7-6.7.4ZM5.2 4.4l2.8-.1.5 13.5-2.9.3ZM1.5 18.1l9-2 .4 2.7-9 2.1Z" />
      <path fillRule="evenodd" d="M11.3 2.5h9.1v14.2h-9.1Zm2.8 2.6v1.6h3.5V5.1Zm0 4v1.5h3.5V9.1Zm0 4v1h3.5v-1Z" />
      <path d="M12.5 15.8h3c-.2 4-2.1 6-5.6 7l-1.4-2.4c2.7-.8 3.8-2 4-4.6ZM16.9 15.6h2.9v4.1c0 .5.2.7.7.7h.6c.6 0 .8-.5.9-2l2 1c-.1 2.6-.8 3.6-2.5 3.6h-2.3c-1.6 0-2.3-.8-2.3-2.5Z" />
    </svg>
  </span>;
}
