import { useTranslation } from 'react-i18next';
import type { ExportQueueStatus } from './exportQueueApi';
import { useShortcutDisplay } from './useShortcutDisplay';

type EditedBadgeProps = {
  edited?: boolean;
  queueKnown?: boolean;
  queueStatus?: ExportQueueStatus | null;
  busy?: boolean;
  disabled?: boolean;
  onQueueToggle?: () => void;
  showQueueShortcut?: boolean;
};

export function EditedBadgeIcon() {
  return <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M3 5h14M3 10h14M3 15h14" />
    <path d="M7 3v4M13 8v4M8 13v4" strokeWidth="3" />
  </svg>;
}

export function EditedBadge({ edited, queueKnown, queueStatus, busy = false, disabled = false, onQueueToggle, showQueueShortcut = true }: EditedBadgeProps) {
  const { t } = useTranslation();
  const shortcut = useShortcutDisplay();
  if (edited !== true) return null;

  const known = queueKnown ?? queueStatus != null;
  const isQueued = known && queueStatus != null;
  const locked = queueStatus === 'waiting' || queueStatus === 'encoding' || queueStatus === 'registering';
  const canToggle = known && !!onQueueToggle && !busy && !disabled && !locked;
  const withShortcut = (text: string) => showQueueShortcut ? shortcut.inline(`${text} `, 'exportQueueToggle').trimEnd() : text;
  const description = !known ? t('photos.edited')
    : queueStatus === 'waiting' ? t('photos.exportQueue.waiting')
      : queueStatus === 'encoding' ? t('photos.exportQueue.encoding')
        : queueStatus === 'registering' ? t('photos.exportQueue.registering')
          : queueStatus === 'failed' ? withShortcut(t('photos.exportQueue.failed'))
            : isQueued ? withShortcut(t('photos.exportQueue.remove'))
              : withShortcut(t('photos.exportQueue.add'));
  const stateClass = known
    ? !isQueued ? ' queue-inactive'
      : queueStatus === 'queued' ? ' queue-queued'
        : queueStatus === 'waiting' ? ' queue-waiting'
          : queueStatus === 'encoding' || queueStatus === 'registering' ? ' queue-processing'
            : ' queue-failed'
    : '';
  const classes = `edited-badge${stateClass}${known ? ' queue-aware' : ''}${busy ? ' queue-busy' : ''}${locked || disabled ? ' queue-locked' : ''}${onQueueToggle ? ' edited-badge-interactive' : ''}`;
  const icon = <EditedBadgeIcon />;

  if (onQueueToggle) return <button
    type="button"
    className={classes}
    aria-label={description}
    aria-pressed={known ? isQueued : undefined}
    aria-busy={busy || undefined}
    title={description}
    disabled={!canToggle}
    onClick={onQueueToggle}
  >{icon}</button>;

  return <span className={classes} role="img" aria-label={description} title={description}>{icon}</span>;
}
