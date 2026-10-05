import { useAppSettings } from './appSettings';
import type { ShortcutId } from './editShortcuts';
import { formatShortcut } from './shortcutDisplay';

export function useShortcutDisplay() {
  const { showKeyboardShortcuts } = useAppSettings();
  const label = (id: ShortcutId) => showKeyboardShortcuts ? formatShortcut(id) : undefined;
  return {
    label,
    inline: (description: string, id: ShortcutId) => {
      const shortcut = label(id);
      return shortcut ? `${description}[${shortcut}]` : description;
    },
    title: (description: string, id: ShortcutId) => {
      const shortcut = label(id);
      return shortcut ? `${description} (${shortcut})` : description;
    },
  };
}
