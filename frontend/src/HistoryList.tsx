import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type HistoryRow = { id: string; position: number; description: ReactNode; title?: string; createdAt?: string };

/** Presentation only: each engine owns its entries, persistent identity and cursor semantics. */
export function HistoryList({ rows, cursor, disabled = false, onJump, onMenu }: {
  rows: readonly HistoryRow[]; cursor: number; disabled?: boolean; onJump: (position: number) => void;
  onMenu?: (position: number, trigger: HTMLElement, x?: number, y?: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const menu = (position: number, event: React.MouseEvent<HTMLButtonElement>) => {
    if (!disabled && onMenu) { event.preventDefault(); onMenu(position, event.currentTarget, event.clientX, event.clientY); }
  };
  const keyMenu = (position: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!disabled && onMenu && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); onMenu(position, event.currentTarget);
    }
  };
  return <ol className="edit-history">
    {[...rows].reverse().map(row => <li key={row.id} value={row.position} title={row.title}
      className={[row.position > cursor ? 'undone' : '', row.position === cursor ? 'current' : ''].filter(Boolean).join(' ') || undefined}>
      <button type="button" disabled={disabled} aria-current={row.position === cursor ? 'step' : undefined}
        onContextMenu={event => menu(row.position, event)} onKeyDown={event => keyMenu(row.position, event)}
        onClick={() => onJump(row.position)}>
        {row.description}
        {row.createdAt && <> · <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString(i18n.language)}</time></>}
      </button>
    </li>)}
    <li className={`initial-state${cursor === 0 ? ' current' : ''}`}>
      <button type="button" disabled={disabled} aria-current={cursor === 0 ? 'step' : undefined}
        onContextMenu={event => menu(cursor, event)} onKeyDown={event => keyMenu(cursor, event)}
        onClick={() => onJump(0)}>{t('workspace.initialState')}</button>
    </li>
  </ol>;
}
