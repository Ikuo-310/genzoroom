import { useTranslation } from 'react-i18next';

export function EditedBadge({ edited }: { edited?: boolean }) {
  const { t } = useTranslation();
  if (edited !== true) return null;
  return <span className="edited-badge" role="img" aria-label={t('photos.edited')} title={t('photos.edited')}>
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 5h14M3 10h14M3 15h14" />
      <path d="M7 3v4M13 8v4M8 13v4" strokeWidth="3" />
    </svg>
  </span>;
}
