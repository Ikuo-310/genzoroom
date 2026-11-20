export type ShortcutPlatform = 'mac' | 'other';

export function shortcutPlatform(): ShortcutPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'mac' : 'other';
}

export function isPrimaryModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'> | Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  platform: ShortcutPlatform = shortcutPlatform(),
): boolean {
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function isAlternateModifier(event: Pick<KeyboardEvent, 'altKey'> | Pick<MouseEvent, 'altKey'>): boolean {
  return event.altKey;
}
