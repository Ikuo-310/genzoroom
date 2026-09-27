import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

type Props = {
  disabled: boolean; hasClipboard: boolean;
  onCopy: () => boolean; onPaste: () => boolean;
  onSelectCopy: () => boolean; onSelectPaste: () => boolean;
  contextPosition?: { x: number; y: number } | null;
  onContextClose?: (restoreFocus: boolean) => void;
  onMenuOpen?: () => void;
  closeMenuSignal?: number;
};

type Action = { label: string; action: () => boolean; disabled: boolean };

export function editMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, margin = 8) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}

function EditSettingsActions({ actions, onSelect, menuItems = true }: {
  actions: Action[]; onSelect: (action: () => boolean) => void; menuItems?: boolean;
}) {
  const { t } = useTranslation();
  return <>{actions.map(({ label, action, disabled }, index) => <Fragment key={label}>
    {index === 2 && <div role="separator" aria-orientation="horizontal" className="edit-settings-menu-separator" />}
    <button type="button" className="workspace-menu-item edit-settings-menu-item"
      {...(menuItems ? { role: 'menuitem' as const } : {})}
      disabled={disabled} onClick={() => onSelect(action)}>{t(label)}</button>
  </Fragment>)}</>;
}

function ContextEditSettingsMenu({ position, actions, onClose, onSelect }: {
  position: { x: number; y: number }; actions: Action[];
  onClose: (restoreFocus: boolean) => void; onSelect: (action: () => boolean) => void;
}) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState({ left: position.x, top: position.y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setLocation(editMenuPosition(position.x, position.y, bounds.width, bounds.height, innerWidth, innerHeight));
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [position.x, position.y]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); onClose(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [onClose]);

  return createPortal(<div ref={menu} role="menu" aria-label={t('workspace.editSettingsActions')}
    className="workspace-menu-surface edit-settings-context-menu edit-settings-action-list" style={{ left: location.left, top: location.top }}
    onKeyDownCapture={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}
    onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onClose(false); }}>
    <EditSettingsActions actions={actions} onSelect={onSelect} />
  </div>, document.body);
}

export function EditSettingsMenu({ disabled, hasClipboard, onCopy, onPaste, onSelectCopy, onSelectPaste,
  contextPosition = null, onContextClose = () => undefined, onMenuOpen, closeMenuSignal = 0 }: Props) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const actions: Action[] = [
    { label: 'workspace.copyAll', action: onCopy, disabled },
    { label: 'workspace.selectCopy', action: onSelectCopy, disabled },
    { label: 'workspace.pasteCopied', action: onPaste, disabled: disabled || !hasClipboard },
    { label: 'workspace.selectPaste', action: onSelectPaste, disabled: disabled || !hasClipboard },
  ];
  const selectFromToolbar = (action: () => boolean) => {
    menu.current!.open = false;
    trigger.current?.focus({ preventScroll: true });
    action();
  };
  const selectFromContext = (action: () => boolean) => {
    onContextClose(false);
    const viewport = menu.current?.closest('.viewer-panel')?.querySelector<HTMLElement>('.viewer-viewport');
    viewport?.focus({ preventScroll: true });
    action();
  };

  useEffect(() => { if (contextPosition || closeMenuSignal) menu.current!.open = false; }, [contextPosition, closeMenuSignal]);

  return <>
  <details ref={menu} className="edit-settings-menu" onClick={onMenuOpen} onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }}>
    <summary ref={trigger} className="tool-button" aria-label={t('workspace.editSettingsActions')} title={t('workspace.editSettingsActions')}>⋯</summary>
    <div className="workspace-menu-surface edit-settings-menu-actions edit-settings-action-list">
      <EditSettingsActions actions={actions} onSelect={selectFromToolbar} menuItems={false} />
    </div>
  </details>
  {contextPosition && <ContextEditSettingsMenu position={contextPosition} actions={actions}
    onClose={onContextClose} onSelect={selectFromContext} />}
  </>;
}
