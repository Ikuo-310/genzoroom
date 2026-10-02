import { shortcutBindings, type ShortcutId } from './editShortcuts';

export type ShortcutPlatform = 'mac' | 'other';
type DisplayBinding = { key?: string; code?: string; ctrlOrMeta?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean };

export function shortcutPlatform(): ShortcutPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'mac' : 'other';
}

function displayKey(binding: DisplayBinding) {
  if (binding.code === 'Backslash') return '\\';
  if (binding.code?.startsWith('Numpad')) return `Numpad ${binding.code.slice(6) === 'Decimal' ? '.' : binding.code.slice(6)}`;
  const key = binding.key ?? binding.code ?? '';
  return ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' } as Record<string, string>)[key]
    ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatShortcut(id: ShortcutId, platform: ShortcutPlatform = shortcutPlatform()): string {
  const bindings: readonly DisplayBinding[] = shortcutBindings[id];
  return bindings.map(binding => {
    const modifiers = [];
    // Only ctrlOrMeta is platform-dependent; explicit Ctrl remains Ctrl on macOS.
    if (binding.ctrl || binding.ctrlOrMeta && platform !== 'mac') modifiers.push('Ctrl');
    if (binding.meta || binding.ctrlOrMeta && platform === 'mac') modifiers.push(platform === 'mac' ? '⌘' : 'Meta');
    if (binding.alt) modifiers.push('Alt');
    if (binding.shift) modifiers.push('Shift');
    return [...modifiers, displayKey(binding)].join('+');
  }).join(' / ');
}
