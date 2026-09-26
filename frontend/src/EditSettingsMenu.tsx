import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  disabled: boolean; hasClipboard: boolean;
  onCopy: () => boolean; onPaste: () => boolean;
  onSelectCopy: () => boolean; onSelectPaste: () => boolean;
};

export function EditSettingsMenu({ disabled, hasClipboard, onCopy, onPaste, onSelectCopy, onSelectPaste }: Props) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const actions = [
    { label: 'workspace.copyAll', action: onCopy, disabled },
    { label: 'workspace.selectCopy', action: onSelectCopy, disabled },
    { label: 'workspace.pasteCopied', action: onPaste, disabled: disabled || !hasClipboard },
    { label: 'workspace.selectPaste', action: onSelectPaste, disabled: disabled || !hasClipboard },
  ];
  return <details ref={menu} className="edit-settings-menu" onBlur={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }}>
    <summary ref={trigger} className="tool-button" aria-label={t('workspace.editSettingsActions')} title={t('workspace.editSettingsActions')}>⋯</summary>
    <div className="edit-settings-menu-actions">
      {actions.map(({ label, action, disabled: unavailable }) => <button key={label} type="button" className="tool-button"
        disabled={unavailable} onClick={() => {
          menu.current!.open = false;
          // Restore to the visible menu trigger, rather than a hidden menu item.
          trigger.current?.focus({ preventScroll: true });
          action();
        }}>{t(label)}</button>)}
    </div>
  </details>;
}
