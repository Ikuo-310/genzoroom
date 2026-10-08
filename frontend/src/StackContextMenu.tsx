import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { RecentAsset } from './assets';
import { FilenameDisplay } from './FilenameDisplay';
import type { ExportQueueStatus } from './exportQueueApi';

export type StackQueueRow = { status: ExportQueueStatus | undefined; known: boolean; busy: boolean };

export function StackContextMenu({
  point, members, selectedIds, selectionAvailable, editStatuses, editStatusState, queueLoaded, queueCurrent, queueError,
  queueFor, onDarkroomToggle, onQueueToggle, onClose,
}: {
  point: { x: number; y: number };
  members: readonly RecentAsset[] | null;
  selectedIds: ReadonlySet<string>;
  selectionAvailable: boolean;
  editStatuses: Readonly<Record<string, boolean | undefined>>;
  editStatusState: 'loading' | 'ready' | 'partial' | 'error';
  queueLoaded: boolean;
  queueCurrent: boolean;
  queueError: boolean;
  queueFor: (assetId: string) => StackQueueRow;
  onDarkroomToggle: (asset: RecentAsset, checked: boolean) => void;
  onQueueToggle: (asset: RecentAsset, checked: boolean) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const lastFocusedControl = useRef<HTMLInputElement | null>(null);
  const initialFocusSet = useRef(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const reposition = useCallback(() => {
    const bounds = menuRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const next = {
      left: Math.max(8, Math.min(point.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(point.y, window.innerHeight - bounds.height - 8)),
    };
    setPosition(current => current?.left === next.left && current.top === next.top ? current : next);
  }, [point]);

  useLayoutEffect(() => {
    reposition();
  }, [point, reposition]);

  useLayoutEffect(() => {
    // Placement must commit visibility before native focus can succeed; later reflows retain user focus.
    if (!position || initialFocusSet.current) return;
    const menu = menuRef.current;
    if (!menu) return;
    const sections = menu.querySelectorAll('section');
    const firstEnabled = [...sections].flatMap(section => [...section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')])
      .find(control => !control.disabled);
    initialFocusSet.current = true;
    (firstEnabled ?? menu).focus();
  }, [position]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    observer?.observe(menu);
    window.addEventListener('resize', reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  useLayoutEffect(() => {
    const focused = lastFocusedControl.current;
    if (!focused || (focused.isConnected && !focused.disabled)) return;
    const menu = menuRef.current;
    if (menu && (document.activeElement === focused || !menu.contains(document.activeElement))) {
      // Only recover focus when its former control became unusable; async content must not steal active focus.
      menu.focus();
    }
    lastFocusedControl.current = null;
  }, [members, editStatuses, editStatusState, queueLoaded, queueCurrent, queueError, queueFor, selectionAvailable]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onCloseRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(true); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, []);

  const validMembers = members?.filter(member => member.isGenzoRoomExport === false) ?? [];
  const queueMembers = members?.filter(member => editStatuses[member.id] === true || queueFor(member.id).known && queueFor(member.id).status !== undefined) ?? [];
  const darkroomStatus = !selectionAvailable ? 'unavailable' : validMembers.length === 0 ? 'empty' : 'ready';
  const unresolvedEditStatus = members?.some(member => editStatuses[member.id] === undefined) ?? false;
  const queueStatus = queueError ? 'error' : !queueLoaded || !queueCurrent ? 'loading'
    : !members ? 'error'
      : queueMembers.length > 0 ? 'ready'
      : editStatusState === 'loading' ? 'loading'
        : unresolvedEditStatus || editStatusState !== 'ready' ? 'error' : 'empty';

  const menu = <div ref={menuRef} className="stack-photo-context-menu workspace-menu-surface" role="dialog" tabIndex={-1}
    onFocusCapture={event => {
      const target = event.target;
      lastFocusedControl.current = target instanceof HTMLInputElement ? target : null;
    }}
    aria-label={t('photos.stackMenu.label')} style={{ left: position?.left ?? point.x, top: position?.top ?? point.y, visibility: position ? 'visible' : 'hidden' }}>
    <section aria-labelledby="stack-darkroom-heading">
      <h3 id="stack-darkroom-heading">{t('photos.stackMenu.darkroom')}</h3>
      {darkroomStatus === 'unavailable' ? <p role="status">{t('photos.stackMenu.membersUnavailable')}</p>
        : darkroomStatus === 'empty' ? <p role="status">{t('photos.stackMenu.noCandidates')}</p>
          : validMembers.map(member => <label className="stack-photo-menu-row" key={member.id.toLowerCase()}>
            <input type="checkbox" checked={selectedIds.has(member.id.toLowerCase())}
              onChange={event => onDarkroomToggle(member, event.currentTarget.checked)} />
            <FilenameDisplay filename={member.filename} />
          </label>)}
    </section>
    <div className="stack-photo-menu-separator" role="separator" />
    <section aria-labelledby="stack-queue-heading">
      <h3 id="stack-queue-heading">{t('photos.stackMenu.queue')}</h3>
      {queueStatus === 'loading' ? <p role="status">{t('photos.stackMenu.loading')}</p>
        : queueStatus === 'error' ? <p role="alert">{queueError ? t('photos.stackMenu.unavailable')
          : !members ? t('photos.stackMenu.membersUnavailable')
            : editStatusState === 'error' ? t('photos.stackMenu.editStatusError') : t('photos.stackMenu.unavailable')}</p>
          : queueStatus === 'empty' ? <p role="status">{t('photos.stackMenu.noCandidates')}</p>
            : <>{editStatusState === 'loading' && <p role="status">{t('photos.stackMenu.loading')}</p>}
              {editStatusState === 'partial' && <p role="status">{t('photos.stackMenu.partial')}</p>}
              {editStatusState === 'error' && <p role="alert">{t('photos.stackMenu.editStatusError')}</p>}
              {unresolvedEditStatus && editStatusState === 'ready' && <p role="status">{t('photos.stackMenu.partial')}</p>}
              {queueMembers.map(member => {
              const row = queueFor(member.id);
              const queued = row.status !== undefined;
              const locked = row.busy || !queueCurrent || !row.known || ['waiting', 'encoding', 'registering'].includes(row.status ?? '');
              return <label className="stack-photo-menu-row" key={member.id.toLowerCase()}>
                <input type="checkbox" checked={queued}
                  disabled={locked} onChange={event => onQueueToggle(member, event.currentTarget.checked)} />
                <FilenameDisplay filename={member.filename} />
              </label>;
            })}</>}
    </section>
  </div>;

  return createPortal(menu, document.body);
}

