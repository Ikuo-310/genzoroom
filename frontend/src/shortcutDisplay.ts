import { shortcutBindings, type ShortcutId } from './editShortcuts';
import { shortcutPlatform, type ShortcutPlatform } from './shortcutModifiers';
import type { ShortcutBinding } from './editShortcuts';

export { shortcutPlatform } from './shortcutModifiers';
export type { ShortcutPlatform } from './shortcutModifiers';

function displayKey(binding: ShortcutBinding) {
  if (binding.code === 'Backslash') return '\\';
  if (binding.code === 'NumpadSubtract') return 'Numpad -';
  if (binding.code === 'NumpadAdd') return 'Numpad +';
  if (binding.code?.startsWith('Numpad')) return `Numpad ${binding.code.slice(6) === 'Decimal' ? '.' : binding.code.slice(6)}`;
  const key = binding.key ?? binding.code ?? '';
  return ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' } as Record<string, string>)[key]
    ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatShortcut(id: ShortcutId, platform: ShortcutPlatform = shortcutPlatform()): string {
  const bindings: readonly ShortcutBinding[] = shortcutBindings[id];
  return bindings.map(binding => {
    const modifiers = [];
    if (binding.primary || binding.ctrl) modifiers.push(platform === 'mac' && binding.primary ? '⌘' : 'Ctrl');
    if (binding.meta) modifiers.push(platform === 'mac' ? '⌘' : 'Meta');
    if (binding.alternate) modifiers.push(platform === 'mac' ? '⌥' : 'Alt');
    else if (binding.alt) modifiers.push(platform === 'mac' ? '⌥' : 'Alt');
    if (binding.shift) modifiers.push(platform === 'mac' ? '⇧' : 'Shift');
    return [...modifiers, displayKey(binding)].join('+');
  }).join(' / ');
}
